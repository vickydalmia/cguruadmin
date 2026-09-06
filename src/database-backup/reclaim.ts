import type { RunnerContext } from './execute-run';
import { logDatabaseBackup } from './log';
import { abortMultipartUploads, headBackupObject, readSidecarSha256 } from './s3-objects';
import { handBackStaleRun, reconcileRunSucceeded } from './store';
import type { RunRow } from './store-rows';

export type StaleRunOutcome = 'reconciled' | 'pending' | 'failed' | 'deferred' | 'lost';

/**
 * What to do with a run whose worker vanished. The bucket is inspected FIRST,
 * while the row still sits `running` under its dead lease, and only then is
 * the row's fate decided. The reclaim path NEVER deletes: every archive
 * carries its own run row as `running` (stamped before pg_dump, finished after
 * the upload), so after a database restore the source archive's row comes
 * back exactly like a crashed run.
 *
 * - Object committed at the row's key → the upload provably completed. The
 *   row goes straight to `succeeded` (size, ETag, sidecar sha256); retention
 *   or the admin owns the object from here.
 * - Nothing committed → abort any open multipart, then hand the row back for
 *   its one retry (or fail it).
 * - Bucket unreachable → touch nothing. The row stays `running`, so nothing
 *   can claim it and stamp a new key over the one that still names an
 *   archive nobody has looked at; the next tick inspects again.
 * - No key at all (died before the target was stamped) → nothing to inspect,
 *   hand back straight away.
 */
export async function reconcileStaleRun(
  ctx: RunnerContext,
  row: RunRow,
  autoVerify: boolean,
  now: Date,
): Promise<StaleRunOutcome> {
  const { strapi, client } = ctx;
  const runId = String(row.id);
  const lockToken = String(row.lock_token ?? '');
  const handBack = async () => {
    const outcome = await handBackStaleRun(strapi, row, now);
    logDatabaseBackup(strapi, 'warn', outcome === 'lost' ? 'backup.reclaim_lost' : 'backup.stale_reclaimed', {
      runId, worker: row.worker_id, key: row.s3_key ?? null, next: outcome,
    });
    return outcome;
  };
  if (!row.s3_key) return handBack();

  const bucket = String(row.s3_bucket ?? ctx.config.s3.bucket);
  const key = String(row.s3_key);
  let head;
  try {
    head = await headBackupObject(client, bucket, key);
  } catch (error) {
    logDatabaseBackup(strapi, 'warn', 'backup.reclaim_inspect_failed', {
      runId, key, error: String((error as Error)?.message ?? error),
    });
    return 'deferred';
  }
  if (!head.exists) {
    await abortMultipartUploads(client, bucket, key).catch(() => undefined);
    return handBack();
  }
  const sha256 = await readSidecarSha256(client, bucket, key).catch(() => null);
  const reconciled = await reconcileRunSucceeded(strapi, runId, lockToken, {
    s3_bucket: bucket,
    s3_key: key,
    size_bytes: head.sizeBytes,
    sha256,
    etag: head.etag,
    verify_state: autoVerify ? 'pending' : null,
  });
  logDatabaseBackup(strapi, reconciled ? 'info' : 'warn', reconciled ? 'backup.reclaimed_reconciled' : 'backup.reclaim_reconcile_lost', {
    runId, key, bytes: head.sizeBytes, sidecar: sha256 !== null,
  });
  return reconciled ? 'reconciled' : 'lost';
}
