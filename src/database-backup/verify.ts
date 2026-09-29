import type { S3Client } from '@aws-sdk/client-s3';
import { pipeline } from 'node:stream/promises';

import type { DatabaseBackupConfig } from './config';
import { KILL_GRACE_MS } from './constants';
import { spawnProcess, type SpawnFn } from './pg-dump';
import { openBackupObjectStream } from './s3-objects';

/**
 * Proves an uploaded archive is readable: stream it back from S3 into
 * `pg_restore --list`, which parses the archive header and the table of
 * contents and fails on a truncated or corrupt head. The TOC entry count is
 * stored so a Super Admin can compare backups at a glance. Nothing touches
 * disk.
 *
 * The listing only needs the head of a custom-format archive: pg_restore
 * exits as soon as the table of contents is printed, without reading the
 * table data behind it. The pipe then closes under the writer (EPIPE or a
 * premature close), which is the normal end of a verification, not a fault.
 * The child's exit status therefore decides the result; a stream error is
 * only reported alongside a non-zero exit. The data section itself is not
 * checked by this protocol.
 */

export type VerifyResult = { ok: true; tocEntries: number } | { ok: false; error: string };

export async function verifyArchive(input: {
  client: S3Client;
  config: DatabaseBackupConfig;
  /** The bucket recorded on the run, which may differ from today's config. */
  bucket: string;
  key: string;
  childEnv: Record<string, string>;
  spawnImpl?: SpawnFn;
  abortSignal?: AbortSignal;
}): Promise<VerifyResult> {
  const restore = spawnProcess(
    input.config.pgRestorePath,
    ['--list'],
    input.childEnv,
    [],
    { stdin: 'pipe', spawnImpl: input.spawnImpl },
  );

  let tocEntries = 0;
  let pendingLine = '';
  restore.child.stdout?.setEncoding('utf8');
  restore.child.stdout?.on('data', (chunk: string) => {
    const lines = (pendingLine + chunk).split('\n');
    pendingLine = lines.pop() ?? '';
    for (const line of lines) if (/^\d+;/.test(line)) tocEntries += 1;
  });

  const onAbort = () => restore.kill();
  input.abortSignal?.addEventListener('abort', onAbort, { once: true });
  let streamError: string | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  try {
    if (input.abortSignal?.aborted) throw new Error('verification cancelled');
    const source = await openBackupObjectStream(input.client, input.bucket, input.key, input.abortSignal);
    await pipeline(source, restore.child.stdin!, { signal: input.abortSignal });
  } catch (error) {
    streamError = String((error as Error)?.message ?? error);
    // Whatever failed, pg_restore must see end-of-input instead of waiting on
    // stdin forever: `pipeline` already destroyed the pipe when the source or
    // the pipe itself failed, and a failed S3 open never wrote to it. A child
    // that has already listed the archive exits 0 on its own; one still
    // reading fails on the truncated input. Never kill it here: a SIGTERM
    // racing the normal exit would turn a good listing into a failure.
    restore.child.stdin?.destroy();
    grace = setTimeout(() => restore.kill(), KILL_GRACE_MS);
    grace.unref?.();
  }

  const exit = await restore.exited;
  if (grace) clearTimeout(grace);
  input.abortSignal?.removeEventListener('abort', onAbort);
  if (/^\d+;/.test(pendingLine)) tocEntries += 1;
  if (input.abortSignal?.aborted) return { ok: false, error: 'verification cancelled' };
  if (exit.spawnError) return { ok: false, error: `pg_restore could not start: ${exit.spawnError}` };
  if (exit.code !== 0 || exit.signal) {
    const reason = exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`;
    const details = [exit.stderrTail, streamError ? `archive stream: ${streamError}` : '']
      .filter(Boolean)
      .join('; ');
    return { ok: false, error: `pg_restore --list failed (${reason})${details ? `: ${details}` : ''}` };
  }
  if (tocEntries === 0) {
    return {
      ok: false,
      error: `pg_restore --list produced an empty table of contents${streamError ? ` (archive stream: ${streamError})` : ''}`,
    };
  }
  return { ok: true, tocEntries };
}
