import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';

import { BACKUP_RUN_ACTIVE_STATUSES, type BackupTrigger } from '../constants/database-backup';
import { isPostgresConnection } from '../utils/database-dialect';
import {
  DATABASE_BACKUP_RUNS_TABLE,
  ERROR_MAX_LENGTH,
  MAX_RUN_ATTEMPTS,
  STALE_RUN_MS,
} from './constants';
import { activeRunRow, type RunRow } from './store-rows';

/**
 * Lifecycle writes on `database_backup_runs`. The lease model is the ISR
 * outbox one: a claim stamps `lock_token`, and every later write is guarded
 * by `{ id, status: 'running', lock_token }` so a worker whose lease was
 * reclaimed sees `owned: false` instead of overwriting the new owner.
 */

const TABLE = DATABASE_BACKUP_RUNS_TABLE;

function isUniqueViolation(cause: unknown): boolean {
  const code = String((cause as any)?.code ?? '');
  const message = String((cause as any)?.message ?? '');
  return code === '23505' || code.startsWith('SQLITE_CONSTRAINT') || /unique/i.test(message);
}

export type EnqueueInput = {
  trigger: BackupTrigger;
  scheduleSlot?: Date | null;
  requestedById?: number | null;
  requestedByLabel?: string | null;
  note?: string | null;
};

/**
 * Insert a pending run unless one is already active. The partial unique index
 * is the race backstop: a concurrent insert surfaces as a unique violation and
 * is reported as "not created" with the winner's row.
 */
export async function enqueueRun(
  strapi: Core.Strapi,
  input: EnqueueInput,
): Promise<{ created: boolean; row: RunRow }> {
  try {
    return await strapi.db.transaction(async ({ trx }: any) => {
      let activeQuery = trx(TABLE).whereIn('status', [...BACKUP_RUN_ACTIVE_STATUSES]).orderBy('created_at', 'asc');
      if (isPostgresConnection(trx)) activeQuery = activeQuery.forUpdate();
      const active = await activeQuery.first();
      if (active) return { created: false as const, row: active };
      const row: RunRow = {
        id: randomUUID(),
        trigger: input.trigger,
        schedule_slot: input.scheduleSlot ?? null,
        requested_by_id: input.requestedById ?? null,
        requested_by_label: input.requestedByLabel ?? null,
        note: input.note ?? null,
        status: 'pending',
        attempt_count: 0,
        created_at: new Date(),
      };
      await trx(TABLE).insert(row);
      return { created: true as const, row };
    });
  } catch (cause) {
    if (!isUniqueViolation(cause)) throw cause;
    const active = await activeRunRow(strapi);
    if (!active) throw cause;
    return { created: false, row: active };
  }
}

export type Claim = { id: string; lockToken: string; row: RunRow };

/** Take the oldest pending run for this worker. */
export async function claimNextRun(strapi: Core.Strapi, workerId: string): Promise<Claim | null> {
  return strapi.db.transaction(async ({ trx }: any) => {
    let query = trx(TABLE).where({ status: 'pending' }).orderBy('created_at', 'asc');
    if (isPostgresConnection(trx)) query = query.forUpdate().skipLocked();
    const row = await query.first();
    if (!row) return null;
    const lockToken = randomUUID();
    const now = new Date();
    const patch = {
      status: 'running',
      lock_token: lockToken,
      worker_id: workerId,
      locked_at: now,
      heartbeat_at: now,
      started_at: now,
      finished_at: null,
      error: null,
      attempt_count: Number(row.attempt_count ?? 0) + 1,
    };
    await trx(TABLE).where({ id: row.id, status: 'pending' }).update(patch);
    return { id: String(row.id), lockToken, row: { ...row, ...patch } };
  });
}

/**
 * Running rows whose worker stopped heartbeating. Each goes back to pending
 * (one retry) or to failed. Returns what was reclaimed so the caller can
 * abort any multipart upload left behind.
 */
export async function reclaimStaleRuns(strapi: Core.Strapi, now: Date): Promise<RunRow[]> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const stale: RunRow[] = await strapi.db
    .connection(TABLE)
    .where({ status: 'running' })
    .where('heartbeat_at', '<', cutoff);
  const reclaimed: RunRow[] = [];
  for (const row of stale) {
    const retry = Number(row.attempt_count ?? 0) < MAX_RUN_ATTEMPTS;
    const updated = await strapi.db
      .connection(TABLE)
      .where({ id: row.id, status: 'running', lock_token: row.lock_token })
      .update(
        retry
          ? { status: 'pending', lock_token: null, locked_at: null, heartbeat_at: null, error: 'runner lost its lease; retrying' }
          : { status: 'failed', lock_token: null, locked_at: null, finished_at: now, error: 'runner lost its lease' },
      );
    if (Number(updated) === 1) reclaimed.push(row);
  }
  return reclaimed;
}

/**
 * A reclaimed run whose archive turned out to be committed in the bucket (the
 * worker died between the S3 commit and `finishRun`, or the database was
 * restored FROM this very archive, which carries its own row as `running`)
 * becomes a normal success so retention and the admin own the object. Only a
 * row the reclaim just handed back (pending/failed, no lease) qualifies.
 */
export async function reconcileRunSucceeded(
  strapi: Core.Strapi,
  id: string,
  patch: {
    s3_bucket: string;
    s3_key: string;
    size_bytes: number | null;
    sha256: string | null;
    etag: string | null;
    verify_state: 'pending' | null;
  },
): Promise<boolean> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, lock_token: null })
    .whereIn('status', ['pending', 'failed'])
    .update({
      ...patch,
      status: 'succeeded',
      finished_at: new Date(),
      locked_at: null,
      heartbeat_at: null,
      cancel_requested_at: null,
      error: null,
      verify_error: null,
      verify_heartbeat_at: null,
    });
  return Number(updated) === 1;
}

/** Record where the archive is going before the first byte is uploaded, so a
 * reclaimed run can abort its multipart and a failed one shows its key. */
export async function stampRunTarget(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  patch: { s3_bucket: string; s3_key: string; pg_dump_version: string | null; server_version: string | null },
): Promise<boolean> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'running', lock_token: lockToken })
    .update(patch);
  return Number(updated) === 1;
}

export type OwnedResult = { owned: boolean; cancelRequested: boolean };

/** Refresh the lease; also reports whether a cancel was requested meanwhile. */
export async function heartbeatRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  patch: { size_bytes?: number } = {},
): Promise<OwnedResult> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'running', lock_token: lockToken })
    .update({ heartbeat_at: new Date(), ...patch });
  if (Number(updated) !== 1) return { owned: false, cancelRequested: false };
  const row = await strapi.db.connection(TABLE).where({ id }).first('cancel_requested_at');
  return { owned: true, cancelRequested: Boolean(row?.cancel_requested_at) };
}

export type FinishPatch = {
  s3_bucket: string;
  s3_key: string;
  size_bytes: number;
  sha256: string;
  etag: string | null;
  duration_ms: number;
  pg_dump_version: string | null;
  server_version: string | null;
  verify_state: 'pending' | null;
};

export async function finishRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  patch: FinishPatch,
): Promise<boolean> {
  const now = new Date();
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'running', lock_token: lockToken })
    .update({
      ...patch,
      status: 'succeeded',
      finished_at: now,
      heartbeat_at: now,
      lock_token: null,
      locked_at: null,
      error: null,
      verify_requested_at: patch.verify_state === 'pending' ? now : null,
    });
  return Number(updated) === 1;
}

export async function failRun(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  error: string,
  status: 'failed' | 'cancelled' = 'failed',
): Promise<boolean> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'running', lock_token: lockToken })
    .update({
      status,
      finished_at: new Date(),
      lock_token: null,
      locked_at: null,
      error: error.slice(0, ERROR_MAX_LENGTH),
    });
  return Number(updated) === 1;
}

/** Shutdown mid-run: give the row back so the next runner retries it once. */
export async function releaseForRetry(
  strapi: Core.Strapi,
  id: string,
  lockToken: string,
  attemptCount: number,
  reason: string,
): Promise<'pending' | 'failed' | 'lost'> {
  if (attemptCount >= MAX_RUN_ATTEMPTS) {
    return (await failRun(strapi, id, lockToken, reason)) ? 'failed' : 'lost';
  }
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'running', lock_token: lockToken })
    .update({ status: 'pending', lock_token: null, locked_at: null, heartbeat_at: null, error: reason });
  return Number(updated) === 1 ? 'pending' : 'lost';
}

/**
 * Pending → cancelled immediately; running → flagged for the worker to stop.
 * The row is locked for the decision (Postgres `FOR UPDATE`; the runner's
 * claim uses `SKIP LOCKED`, so it simply passes over the row this tick) and
 * each transition is judged by its own update count: a claim that lands
 * between the read and the write must turn into the running-state flag, never
 * into a "cancelled" answer while the dump goes on.
 */
export async function requestCancel(strapi: Core.Strapi, id: string): Promise<'cancelled' | 'requested' | 'not-active'> {
  return strapi.db.transaction(async ({ trx }: any) => {
    let query = trx(TABLE).where({ id });
    if (isPostgresConnection(trx)) query = query.forUpdate();
    const row = await query.first();
    if (!row) return 'not-active';
    const cancelled = await trx(TABLE)
      .where({ id, status: 'pending' })
      .update({ status: 'cancelled', finished_at: new Date(), error: null });
    if (Number(cancelled) === 1) return 'cancelled';
    const requested = await trx(TABLE)
      .where({ id, status: 'running' })
      .update({ cancel_requested_at: new Date() });
    return Number(requested) === 1 ? 'requested' : 'not-active';
  });
}

export async function requestVerify(strapi: Core.Strapi, id: string): Promise<boolean> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'succeeded' })
    .where((builder: any) => builder.whereNull('verify_state').orWhereIn('verify_state', ['ok', 'failed']))
    .update({ verify_state: 'pending', verify_requested_at: new Date(), verify_error: null });
  return Number(updated) === 1;
}

export async function claimVerify(strapi: Core.Strapi): Promise<RunRow | null> {
  return strapi.db.transaction(async ({ trx }: any) => {
    let query = trx(TABLE).where({ status: 'succeeded', verify_state: 'pending' }).orderBy('verify_requested_at', 'asc');
    if (isPostgresConnection(trx)) query = query.forUpdate().skipLocked();
    const row = await query.first();
    if (!row) return null;
    await trx(TABLE)
      .where({ id: row.id, verify_state: 'pending' })
      .update({ verify_state: 'running', verify_heartbeat_at: new Date() });
    return row;
  });
}

/** Refresh the verification lease; false once the row is no longer running
 * (reclaimed as stale, or finished elsewhere). */
export async function heartbeatVerify(strapi: Core.Strapi, id: string): Promise<boolean> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, verify_state: 'running' })
    .update({ verify_heartbeat_at: new Date() });
  return Number(updated) === 1;
}

export const VERIFY_LEASE_LOST_ERROR = 'verifier lost its lease; request verification again';

/**
 * Running verifications whose worker stopped heartbeating (or, for rows
 * claimed before the lease existed, never did). They become `failed` rather
 * than `pending`: a verifier that dies on this archive every time must not
 * spin, and `failed` is re-requestable from the admin. Returns the rows.
 */
export async function reclaimStaleVerifications(strapi: Core.Strapi, now: Date): Promise<RunRow[]> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const stale: RunRow[] = await strapi.db
    .connection(TABLE)
    .where({ verify_state: 'running' })
    .where((builder: any) => builder.whereNull('verify_heartbeat_at').orWhere('verify_heartbeat_at', '<', cutoff));
  const reclaimed: RunRow[] = [];
  for (const row of stale) {
    const updated = await strapi.db
      .connection(TABLE)
      .where({ id: row.id, verify_state: 'running' })
      .update({ verify_state: 'failed', verified_at: now, verify_heartbeat_at: null, verify_error: VERIFY_LEASE_LOST_ERROR });
    if (Number(updated) === 1) reclaimed.push(row);
  }
  return reclaimed;
}

/** Shutdown mid-verification: hand it back instead of recording a false failure. */
export async function releaseVerify(strapi: Core.Strapi, id: string): Promise<void> {
  await strapi.db
    .connection(TABLE)
    .where({ id, verify_state: 'running' })
    .update({ verify_state: 'pending', verify_heartbeat_at: null });
}

export async function finishVerify(
  strapi: Core.Strapi,
  id: string,
  result: { ok: true; tocEntries: number } | { ok: false; error: string },
): Promise<void> {
  const patch = result.ok === false
    ? { verify_state: 'failed', verified_at: new Date(), verify_error: result.error.slice(0, ERROR_MAX_LENGTH) }
    : { verify_state: 'ok', verified_at: new Date(), verify_toc_entries: result.tocEntries, verify_error: null };
  await strapi.db
    .connection(TABLE)
    .where({ id, verify_state: 'running' })
    .update({ ...patch, verify_heartbeat_at: null });
}

export async function markDeleted(strapi: Core.Strapi, id: string, reason: 'retention' | 'manual'): Promise<boolean> {
  const updated = await strapi.db
    .connection(TABLE)
    .where({ id, status: 'succeeded' })
    .update({ status: 'deleted', deleted_at: new Date(), deleted_reason: reason });
  return Number(updated) === 1;
}
