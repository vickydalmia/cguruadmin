import type { S3Client } from '@aws-sdk/client-s3';
import type { Core } from '@strapi/strapi';

import type { BackupSettings } from '../constants/database-backup';
import { sendBackupFailureAlert } from './alerts';
import type { DatabaseBackupConfig } from './config';
import { RUN_HEARTBEAT_MS, VERIFY_TIMEOUT_MS } from './constants';
import { logDatabaseBackup } from './log';
import { redactSecrets, type PgInvocation } from './pg-connection';
import { spawnPgDump, type SpawnFn } from './pg-dump';
import { applyRetention } from './retention';
import { backupObjectKey } from './s3-client';
import { abortMultipartUploads, deleteBackupObject } from './s3-objects';
import { uploadArchive } from './s3-upload';
import {
  failRun,
  finishRun,
  finishVerify,
  heartbeatRun,
  heartbeatVerify,
  releaseForRetry,
  releaseVerify,
  stampRunTarget,
  type Claim,
} from './store';
import { getRunRow, viewFromRow, type RunRow } from './store-rows';
import { verifyArchive } from './verify';

/**
 * One backup (or one verification) from claim to terminal row. The runner
 * launches these detached and keeps ticking for heartbeats and health; the
 * returned `ActiveJob` lets it stop the work on shutdown and await the row
 * reaching a consistent state before the process exits.
 */

export type RunnerContext = {
  strapi: Core.Strapi;
  config: DatabaseBackupConfig;
  client: S3Client;
  invocation: PgInvocation;
  versions: { pgDump: string | null; server: string | null };
  spawnImpl?: SpawnFn;
};

export type StopReason = 'shutdown';

export type ActiveJob = {
  kind: 'backup' | 'verify';
  id: string;
  stop: (reason: StopReason) => void;
  /** Settles once the row is in its final state for this worker. */
  done: Promise<void>;
};

type Outcome = 'cancel' | 'shutdown' | 'timeout' | 'lease' | null;

export function launchBackup(ctx: RunnerContext, claim: Claim, settings: BackupSettings): ActiveJob {
  const abort = new AbortController();
  let outcome: Outcome = null;
  let kill: (() => void) | null = null;
  const stopWith = (reason: Exclude<Outcome, null>) => {
    if (outcome) return;
    outcome = reason;
    kill?.();
    abort.abort();
  };

  const done = (async () => {
    const { strapi, config, client, invocation } = ctx;
    const startedAt = Date.now();
    const key = backupObjectKey({
      prefix: config.s3.prefix,
      countryCode: config.countryCode!,
      at: new Date(startedAt),
      runId: claim.id,
    });
    const bucket = config.s3.bucket!;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      heartbeat = null;
      timeout = null;
    };

    try {
      if (!(await stampRunTarget(strapi, claim.id, claim.lockToken, {
        s3_bucket: bucket,
        s3_key: key,
        pg_dump_version: ctx.versions.pgDump,
        server_version: ctx.versions.server,
      }))) {
        logDatabaseBackup(strapi, 'warn', 'backup.lease_lost', { runId: claim.id, stage: 'start' });
        return;
      }
      logDatabaseBackup(strapi, 'info', 'backup.started', {
        runId: claim.id, trigger: claim.row.trigger, attempt: claim.row.attempt_count, key,
      });

      const dump = spawnPgDump({
        command: config.pgDumpPath,
        args: invocation.dumpArgs,
        env: invocation.childEnv,
        secrets: invocation.secrets,
        spawnImpl: ctx.spawnImpl,
      });
      kill = dump.kill;

      heartbeat = setInterval(() => {
        void heartbeatRun(strapi, claim.id, claim.lockToken, { size_bytes: dump.archive.bytes }).then(
          (result) => {
            if (!result.owned) stopWith('lease');
            else if (result.cancelRequested) stopWith('cancel');
          },
          () => undefined,
        );
      }, RUN_HEARTBEAT_MS);
      heartbeat.unref?.();
      timeout = setTimeout(() => stopWith('timeout'), config.timeoutMinutes * 60_000);
      timeout.unref?.();

      try {
        const result = await uploadArchive({
          client,
          config,
          key,
          archive: dump.archive,
          metadata: {
            'run-id': claim.id,
            country: config.countryCode!,
            'pg-server': ctx.versions.server ?? 'unknown',
            'pg-dump': ctx.versions.pgDump ?? 'unknown',
          },
          abortSignal: abort.signal,
        });
        clearTimers();
        await dump.exited;
        const durationMs = Date.now() - startedAt;
        const finished = await finishRun(strapi, claim.id, claim.lockToken, {
          s3_bucket: bucket,
          s3_key: key,
          size_bytes: result.bytes,
          sha256: result.sha256,
          etag: result.etag,
          duration_ms: durationMs,
          pg_dump_version: ctx.versions.pgDump,
          server_version: ctx.versions.server,
          verify_state: settings.autoVerify ? 'pending' : null,
        });
        logDatabaseBackup(strapi, finished ? 'info' : 'warn', finished ? 'backup.succeeded' : 'backup.lease_lost', {
          runId: claim.id, key, bytes: result.bytes, sha256: result.sha256, durationMs,
        });
        if (finished) {
          await applyRetention(strapi, client, bucket, settings).catch((error) =>
            logDatabaseBackup(strapi, 'warn', 'backup.retention_failed', { error: String(error?.message ?? error) }));
        } else {
          // Another worker owns the row now and retries under a new key.
          await discardRunObjects(ctx, claim.id, bucket, key);
        }
      } catch (error) {
        clearTimers();
        dump.kill();
        await dump.exited;
        await discardRunObjects(ctx, claim.id, bucket, key);
        const message = redactSecrets(String((error as Error)?.message ?? error), invocation.secrets);
        await settleFailure(ctx, claim, outcome, message, settings);
      }
    } catch (error) {
      clearTimers();
      const message = redactSecrets(String((error as Error)?.message ?? error), invocation.secrets);
      await settleFailure(ctx, claim, outcome, message, settings);
    }
  })();

  return { kind: 'backup', id: claim.id, stop: () => stopWith('shutdown'), done };
}

/**
 * Nothing of a failed run may stay in the bucket: an unfinished multipart is
 * aborted, and an object that was already committed when a later step (size
 * check, sidecar, database write) failed is deleted. A retry mints a new key,
 * and neither retention nor the admin's delete action can reach a failed
 * run's object, so this is the only place that removes it.
 *
 * Worker-side only. A worker that lost its lease (paused past the stale
 * cutoff) may find that the reclaim already reconciled this very key into a
 * success; the row is re-read first and such an archive is kept.
 */
export async function discardRunObjects(ctx: RunnerContext, runId: string, bucket: string, key: string): Promise<void> {
  const { strapi, client } = ctx;
  const current = await getRunRow(strapi, runId).catch(() => null);
  if (current && current.status === 'succeeded' && String(current.s3_key) === key) {
    logDatabaseBackup(strapi, 'info', 'backup.cleanup_skipped', { runId, key, reason: 'archive reconciled as succeeded' });
    return;
  }
  await abortMultipartUploads(client, bucket, key).catch(() => undefined);
  try {
    await deleteBackupObject(client, bucket, key);
  } catch (error) {
    logDatabaseBackup(strapi, 'warn', 'backup.cleanup_failed', {
      runId, key, error: String((error as Error)?.message ?? error),
    });
  }
}

async function settleFailure(
  ctx: RunnerContext,
  claim: Claim,
  outcome: Outcome,
  message: string,
  settings: BackupSettings,
): Promise<void> {
  const { strapi } = ctx;
  const attempt = Number(claim.row.attempt_count ?? 1);
  if (outcome === 'cancel') {
    await failRun(strapi, claim.id, claim.lockToken, 'cancelled by an administrator', 'cancelled');
    logDatabaseBackup(strapi, 'info', 'backup.cancelled', { runId: claim.id });
    return;
  }
  if (outcome === 'shutdown') {
    const state = await releaseForRetry(strapi, claim.id, claim.lockToken, attempt, 'interrupted by a restart; retrying');
    logDatabaseBackup(strapi, 'warn', 'backup.interrupted', { runId: claim.id, state, attempt });
    if (state === 'failed') await alertFailure(ctx, claim.id, settings);
    return;
  }
  if (outcome === 'lease') {
    logDatabaseBackup(strapi, 'warn', 'backup.lease_lost', { runId: claim.id, stage: 'upload' });
    return;
  }
  const reason = outcome === 'timeout'
    ? `timed out after ${ctx.config.timeoutMinutes} minutes`
    : message;
  if (await failRun(strapi, claim.id, claim.lockToken, reason)) {
    await alertFailure(ctx, claim.id, settings);
  }
}

async function alertFailure(ctx: RunnerContext, id: string, settings: BackupSettings): Promise<void> {
  const row = await getRunRow(ctx.strapi, id);
  if (!row) return;
  await sendBackupFailureAlert(ctx.strapi, settings.alertEmail, viewFromRow(row), ctx.config.countryCode);
}

export function launchVerify(ctx: RunnerContext, row: RunRow): ActiveJob {
  const abort = new AbortController();
  const id = String(row.id);
  const done = (async () => {
    const { strapi, config, client, invocation } = ctx;
    const key = String(row.s3_key ?? '');
    // Read from the bucket the run was written to, like download and delete
    // do; today's BACKUP_S3_BUCKET may have changed since.
    const bucket = String(row.s3_bucket ?? config.s3.bucket);
    // Lease: the tick fails a running verification whose heartbeat stopped
    // (SIGKILL, OOM). Stop early if that happened to this one. Deadline: a
    // stalled download or a wedged pg_restore must not hold the runner (and
    // with it every later backup) indefinitely.
    let ended: 'lease' | 'timeout' | null = null;
    const endWith = (reason: 'lease' | 'timeout') => {
      if (ended) return;
      ended = reason;
      abort.abort();
    };
    const heartbeat = setInterval(() => {
      void heartbeatVerify(strapi, id).then((owned) => { if (!owned) endWith('lease'); }, () => undefined);
    }, RUN_HEARTBEAT_MS);
    heartbeat.unref?.();
    const deadline = setTimeout(() => endWith('timeout'), VERIFY_TIMEOUT_MS);
    deadline.unref?.();
    let result: Awaited<ReturnType<typeof verifyArchive>>;
    try {
      result = key
        ? await verifyArchive({
          client, config, bucket, key, childEnv: invocation.childEnv, spawnImpl: ctx.spawnImpl, abortSignal: abort.signal,
        })
        : { ok: false as const, error: 'the run has no stored object key' };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
    if (ended === 'lease') {
      logDatabaseBackup(strapi, 'warn', 'backup.verify_lease_lost', { runId: id, key });
      return;
    }
    if (ended === 'timeout') {
      const error = `verification exceeded ${VERIFY_TIMEOUT_MS / 60_000} minutes`;
      await finishVerify(strapi, id, { ok: false, error });
      logDatabaseBackup(strapi, 'warn', 'backup.verify_failed', { runId: id, key, error });
      return;
    }
    if (abort.signal.aborted) {
      // Put it back for the next runner rather than recording a false failure.
      await releaseVerify(strapi, id);
      return;
    }
    if (result.ok === false) {
      const error = redactSecrets(result.error, invocation.secrets);
      await finishVerify(strapi, id, { ok: false, error });
      logDatabaseBackup(strapi, 'warn', 'backup.verify_failed', { runId: id, key, error });
      return;
    }
    await finishVerify(strapi, id, { ok: true, tocEntries: result.tocEntries });
    logDatabaseBackup(strapi, 'info', 'backup.verified', { runId: id, key, tocEntries: result.tocEntries });
  })();
  return { kind: 'verify', id, stop: () => abort.abort(), done };
}
