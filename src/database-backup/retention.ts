import type { S3Client } from '@aws-sdk/client-s3';
import type { Core } from '@strapi/strapi';

import { BACKUP_MINIMUM_KEPT } from '../constants/database-backup';
import type { BackupSettings } from '../constants/database-backup';
import { logDatabaseBackup } from './log';
import { deleteBackupObject } from './s3-objects';
import { markDeleted } from './store';
import { pruneHistoryRows, succeededRunRows, type RunRow } from './store-rows';

/**
 * Age-based pruning of stored archives, with a floor: the newest
 * `BACKUP_MINIMUM_KEPT` successes are never deleted however old they are, so
 * a broken schedule cannot age every backup out of existence.
 */

export type RetentionCandidate = {
  id: string;
  startedAt: Date | null;
  s3Key: string | null;
  /** The bucket the archive was written to; BACKUP_S3_BUCKET may have moved since. */
  s3Bucket: string | null;
};

export function selectRunsToDelete(
  candidates: RetentionCandidate[],
  input: { deleteAfterDays: number | null; now: Date; minimumKept?: number },
): RetentionCandidate[] {
  if (input.deleteAfterDays === null) return [];
  const minimumKept = input.minimumKept ?? BACKUP_MINIMUM_KEPT;
  const cutoff = input.now.getTime() - input.deleteAfterDays * 24 * 60 * 60_000;
  const ordered = [...candidates].sort(
    (a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0),
  );
  return ordered
    .slice(minimumKept)
    .filter((run) => run.startedAt !== null && run.startedAt.getTime() < cutoff);
}

function candidateFromRow(row: RunRow): RetentionCandidate {
  const started = row.started_at ? new Date(row.started_at) : null;
  return {
    id: String(row.id),
    startedAt: started && !Number.isNaN(started.getTime()) ? started : null,
    s3Key: row.s3_key ? String(row.s3_key) : null,
    s3Bucket: row.s3_bucket ? String(row.s3_bucket) : null,
  };
}

export async function applyRetention(
  strapi: Core.Strapi,
  client: S3Client,
  bucket: string,
  settings: Pick<BackupSettings, 'deleteAfterDays'>,
  now: Date = new Date(),
): Promise<{ deleted: number; failed: number }> {
  const rows = await succeededRunRows(strapi);
  const doomed = selectRunsToDelete(rows.map(candidateFromRow), {
    deleteAfterDays: settings.deleteAfterDays,
    now,
  });
  let deleted = 0;
  let failed = 0;
  for (const run of doomed) {
    try {
      // Delete where the archive is. S3 answers a delete of a missing key with
      // success, so deleting from today's bucket would strand the object.
      if (run.s3Key) await deleteBackupObject(client, run.s3Bucket ?? bucket, run.s3Key);
      if (await markDeleted(strapi, run.id, 'retention')) deleted += 1;
    } catch (error) {
      failed += 1;
      logDatabaseBackup(strapi, 'warn', 'backup.retention_delete_failed', {
        runId: run.id,
        key: run.s3Key,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
  const pruned = await pruneHistoryRows(strapi, now);
  if (deleted || failed || pruned) {
    logDatabaseBackup(strapi, 'info', 'backup.retention', { deleted, failed, prunedRows: pruned });
  }
  return { deleted, failed };
}
