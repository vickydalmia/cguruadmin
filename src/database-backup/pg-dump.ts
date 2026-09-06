import { spawn as nodeSpawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';

import { KILL_GRACE_MS, PG_DUMP_MAGIC, STDERR_TAIL_BYTES } from './constants';
import { redactSecrets } from './pg-connection';

/**
 * Child-process plumbing for `pg_dump` / `pg_restore`: spawn with an
 * allow-listed env, keep a redacted stderr tail, and expose the archive as a
 * stream that can only END CLEANLY when the child exited 0.
 *
 * That last property is load-bearing. `pg_dump` closes stdout before its exit
 * status is known; without waiting, a dump that failed half-way would look
 * like a short but complete archive, and a dump under one multipart part
 * would be committed to S3 as a single PutObject. `ArchiveStream._flush`
 * therefore awaits the exit and errors the stream on any non-zero code.
 */

export type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn-level failure (ENOENT, EACCES) — the process never ran. */
  spawnError: string | null;
  stderrTail: string;
};

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] },
) => ChildProcess;

export type SpawnedProcess = {
  child: ChildProcess;
  exited: Promise<ExitInfo>;
  /** SIGTERM now, SIGKILL after the grace period if it is still alive. */
  kill: () => void;
};

export function spawnProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  secrets: readonly string[],
  options: { stdin?: 'ignore' | 'pipe'; spawnImpl?: SpawnFn } = {},
): SpawnedProcess {
  const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnFn);
  const child = spawnImpl(command, args, {
    env,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  let spawnError: string | null = null;
  const exited = new Promise<ExitInfo>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        signal,
        spawnError,
        stderrTail: redactSecrets(stderrTail.trim(), secrets),
      });
    };
    child.once('error', (error: Error) => {
      spawnError = redactSecrets(error.message, secrets);
      // 'close' still fires after a spawn error on modern Node, but not on
      // every path; settle here so callers never hang.
      setImmediate(() => finish(null, null));
    });
    child.once('close', (code, signal) => finish(code, signal));
  });

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }
  };
  void exited.then(() => {
    if (killTimer) clearTimeout(killTimer);
  });

  return { child, exited, kill };
}

/**
 * Counts bytes, hashes the archive, checks the `PGDMP` magic, and refuses to
 * end until the producing child has exited successfully.
 */
export class ArchiveStream extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');
  private digest: string | null = null;
  private head = Buffer.alloc(0);
  private magicChecked = false;

  constructor(private readonly exited: Promise<ExitInfo>, private readonly label: string) {
    super();
  }

  /** Hex digest of everything streamed so far; finalised on first read. */
  get sha256(): string {
    if (this.digest === null) this.digest = this.hash.digest('hex');
    return this.digest;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.magicChecked) {
      this.head = Buffer.concat([this.head, chunk]);
      if (this.head.length >= PG_DUMP_MAGIC.length) {
        this.magicChecked = true;
        if (this.head.subarray(0, PG_DUMP_MAGIC.length).toString('latin1') !== PG_DUMP_MAGIC) {
          callback(new Error(`${this.label} output is not a PostgreSQL custom-format archive`));
          return;
        }
        this.head = Buffer.alloc(0);
      }
    }
    this.bytes += chunk.length;
    this.hash.update(chunk);
    callback(null, chunk);
  }

  _flush(callback: TransformCallback): void {
    this.exited.then((exit) => {
      if (exit.spawnError) {
        callback(new Error(`${this.label} could not start: ${exit.spawnError}`));
        return;
      }
      if (exit.code !== 0 || exit.signal) {
        const reason = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
        const detail = exit.stderrTail ? `: ${exit.stderrTail.split('\n').slice(-3).join(' ')}` : '';
        callback(new Error(`${this.label} ${reason}${detail}`));
        return;
      }
      if (!this.magicChecked) {
        callback(new Error(`${this.label} produced no archive`));
        return;
      }
      callback();
    }, callback);
  }
}

export type DumpProcess = SpawnedProcess & { archive: ArchiveStream };

export function spawnPgDump(input: {
  command: string;
  args: string[];
  env: Record<string, string>;
  secrets: readonly string[];
  spawnImpl?: SpawnFn;
}): DumpProcess {
  const spawned = spawnProcess(input.command, input.args, input.env, input.secrets, {
    spawnImpl: input.spawnImpl,
  });
  const archive = new ArchiveStream(spawned.exited, 'pg_dump');
  spawned.child.stdout!.pipe(archive);
  spawned.child.stdout!.once('error', (error) => archive.destroy(error));
  return { ...spawned, archive };
}

export type ToolVersion = { version: string; major: number };

export function parseToolVersion(output: string): ToolVersion | null {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return { version: match[2] ? `${match[1]}.${match[2]}` : match[1], major: Number(match[1]) };
}

/** `pg_dump --version` → `{ version: '18.6', major: 18 }`, or null when absent. */
export function toolVersion(command: string, env: Record<string, string>): Promise<ToolVersion | null> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { env, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parseToolVersion(String(stdout)));
    });
  });
}

/** Write the CA PEM as 0600 in a 0700 directory, atomically. */
export async function materialiseCaFile(filePath: string, pem: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, pem, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export async function removeCaFiles(directory: string): Promise<void> {
  try {
    const entries = await fs.readdir(directory);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith('ca-'))
        .map((entry) => fs.rm(path.join(directory, entry), { force: true })),
    );
  } catch {
    // Directory never created — nothing to clean.
  }
}
