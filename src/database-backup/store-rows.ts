import type { Core } from '@strapi/strapi';

import {
  BACKUP_RUN_ACTIVE_STATUSES,
  type BackupRunView,
  type BackupRunsPage,
} from '../constants/database-backup';
import { DATABASE_BACKUP_RUNS_TABLE, HISTORY_RETENTION_DAYS } from './constants';

/**
 * Row mapping and read-only queries on `database_backup_runs`. Lifecycle
 * writes (enqueue, claim, heartbeat, finish, …) live in `store.ts`.
 */

export type RunRow = Record<string, any>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function integer(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function viewFromRow(row: RunRow): BackupRunView {
  return {
    id: String(row.id),
    trigger: row.trigger === 'scheduled' ? 'scheduled' : 'manual',
    scheduleSlot: iso(row.schedule_slot),
    requestedById: integer(row.requested_by_id),
    requestedByLabel: text(row.requested_by_label),
    note: text(row.note),
    status: String(row.status) as BackupRunView['status'],
    attemptCount: integer(row.attempt_count) ?? 0,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    heartbeatAt: iso(row.heartbeat_at),
    cancelRequestedAt: iso(row.cancel_requested_at),
    s3Bucket: text(row.s3_bucket),
    s3Key: text(row.s3_key),
    sizeBytes: integer(row.size_bytes),
    sha256: text(row.sha256),
    durationMs: integer(row.duration_ms),
    pgDumpVersion: text(row.pg_dump_version),
    serverVersion: text(row.server_version),
    error: text(row.error),
    verifyState: (text(row.verify_state) as BackupRunView['verifyState']) ?? null,
    verifyRequestedAt: iso(row.verify_requested_at),
    verifiedAt: iso(row.verified_at),
    verifyTocEntries: integer(row.verify_toc_entries),
    verifyError: text(row.verify_error),
    deletedAt: iso(row.deleted_at),
    deletedReason: text(row.deleted_reason),
  };
}

function table(strapi: Core.Strapi) {
  return strapi.db.connection(DATABASE_BACKUP_RUNS_TABLE);
}

export async function getRunRow(strapi: Core.Strapi, id: string): Promise<RunRow | null> {
  const row = await table(strapi).where({ id }).first();
  return row ?? null;
}

export async function activeRunRow(strapi: Core.Strapi): Promise<RunRow | null> {
  const row = await table(strapi)
    .whereIn('status', [...BACKUP_RUN_ACTIVE_STATUSES])
    .orderBy('created_at', 'asc')
    .first();
  return row ?? null;
}

/** Most recent run that produced an archive — a later retention delete still counts. */
export async function lastSuccessfulRunRow(strapi: Core.Strapi): Promise<RunRow | null> {
  const row = await table(strapi)
    .whereIn('status', ['succeeded', 'deleted'])
    .whereNotNull('started_at')
    .orderBy('started_at', 'desc')
    .first();
  return row ?? null;
}

/** The very first attempt ever recorded — the staleness clock when nothing succeeded yet. */
export async function oldestRunRow(strapi: Core.Strapi): Promise<RunRow | null> {
  const row = await table(strapi).orderBy('created_at', 'asc').first();
  return row ?? null;
}

export async function scheduledSlotExists(strapi: Core.Strapi, slot: Date): Promise<boolean> {
  const row = await table(strapi)
    .where({ trigger: 'scheduled', schedule_slot: slot })
    .whereNot('status', 'cancelled')
    .first('id');
  return Boolean(row);
}

export async function listRuns(
  strapi: Core.Strapi,
  input: { page: number; pageSize: number },
): Promise<BackupRunsPage> {
  const countRow = await table(strapi).count({ total: '*' }).first();
  const total = Number((countRow as any)?.total ?? 0);
  const rows = await table(strapi)
    .orderBy('created_at', 'desc')
    .offset((input.page - 1) * input.pageSize)
    .limit(input.pageSize);
  return {
    runs: rows.map(viewFromRow),
    page: input.page,
    pageSize: input.pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
  };
}

/** Succeeded archives, newest first — the retention candidates. */
export async function succeededRunRows(strapi: Core.Strapi): Promise<RunRow[]> {
  return table(strapi)
    .where({ status: 'succeeded' })
    .whereNotNull('s3_key')
    .orderBy('started_at', 'desc');
}

/** Old terminal rows (history), never an active or still-stored backup. */
export async function pruneHistoryRows(strapi: Core.Strapi, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60_000);
  const deleted = await table(strapi)
    .whereIn('status', ['failed', 'cancelled', 'deleted'])
    .where('created_at', '<', cutoff)
    .delete();
  return Number(deleted);
}
