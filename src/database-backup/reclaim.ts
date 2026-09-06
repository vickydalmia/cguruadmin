import type { RunnerContext } from './execute-run';
import { logDatabaseBackup } from './log';
import { abortMultipartUploads, headBackupObject, readSidecarSha256 } from './s3-objects';
import { reconcileRunSucceeded } from './store';
import type { RunRow } from './store-rows';

/**
 * What to do with the S3 side of a run whose worker vanished. The reclaim
 * path NEVER deletes: every archive carries its own run row as `running`
 * (stamped before pg_dump, finished after the upload), so after a database
 * restore the source archive's row comes back exactly like a crashed run,
 * and deleting "its" object would delete the backup just restored from.
 *
 * - Object committed at the row's key → the upload provably completed. The
 *   row becomes a normal success (size, ETag, sidecar sha256) and retention
 *   or the admin owns the object from here; the retry the reclaim queued is
 *   thereby cancelled.
 * - Nothing committed → abort any open multipart and let the retry run.
 * - Bucket unreachable → touch nothing; the next tick sees the row again.
 */
export async function reconcileReclaimedRun(ctx: RunnerContext, row: RunRow, autoVerify: boolean): Promise<void> {
  const { strapi, client } = ctx;
  if (!row.s3_key) return;
  const runId = String(row.id);
  const bucket = String(row.s3_bucket ?? ctx.config.s3.bucket);
  const key = String(row.s3_key);
  let head;
  try {
    head = await headBackupObject(client, bucket, key);
  } catch (error) {
    logDatabaseBackup(strapi, 'warn', 'backup.reclaim_inspect_failed', {
      runId, key, error: String((error as Error)?.message ?? error),
    });
    return;
  }
  if (!head.exists) {
    await abortMultipartUploads(client, bucket, key).catch(() => undefined);
    return;
  }
  const sha256 = await readSidecarSha256(client, bucket, key).catch(() => null);
  const reconciled = await reconcileRunSucceeded(strapi, runId, {
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
}
