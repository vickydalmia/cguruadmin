/**
 * Edit-lock service: one row per `model:documentId`, held by a single admin
 * user and refreshed by a heartbeat from the edit view. A lock whose
 * `expiresAt` has passed is dead weight — any admin may take it over — so a
 * closed tab or crashed browser can never wedge an entry for longer than
 * LOCK_TTL_MS.
 *
 * Concurrency: the `key` column is UNIQUE. Two admins racing to create the
 * same lock means one INSERT wins and the other hits the constraint; the
 * loser re-reads and reports the winner as holder. Takeover of an expired /
 * own lease is a guarded UPDATE (id + previous holder + per-tab leaseId), so
 * two simultaneous takeovers cannot both succeed silently. The leaseId also
 * prevents one tab from refreshing or releasing another tab's lock when both
 * tabs belong to the same admin user. Release records a short-lived lease
 * cancellation before touching the lock row: if an acquire outlives a failed
 * or closed browser connection, its final cancellation check removes anything
 * it committed instead of leaving an orphan lock.
 */

import type { Core } from '@strapi/strapi';

import { SINGLE_TYPE_LOCK_DOCUMENT_ID } from '../../../constants/record-lock';

const LOCK_UID = 'api::record-lock.record-lock';
const CANCELLATION_UID =
  'api::record-lock-cancellation.record-lock-cancellation';

/** How long a lock or release tombstone survives without a heartbeat. The
 * panel beats every 20 s while holding (10 s while waiting behind someone
 * else's lock), so several missed beats (backgrounded-tab timer throttling,
 * flaky wifi) still keep the lock. Retune alongside HEARTBEAT_MS /
 * BLOCKED_RETRY_MS in
 * src/admin/components/RecordLockPanel.tsx. */
export const LOCK_TTL_MS = 90_000;

export type AdminUserLike = {
  id: number;
  firstname?: string | null;
  lastname?: string | null;
  username?: string | null;
  email?: string | null;
};

export type LockHolder = {
  adminUserId: number;
  holderName: string;
  expiresAt: string;
};

export type AcquireResult =
  | { acquired: true; expiresAt: string }
  /** `self` — the blocking lease belongs to the SAME admin (another tab, or
   * a session a page reload orphaned); the panel offers "Take over" then. */
  | { acquired: false; holder: LockHolder; self: boolean }
  | { acquired: false; cancelled: true };

export type AcquireOptions = {
  /** Steal a lease-mate: permitted ONLY when the current holder is the same
   * admin user (the F5-orphan escape hatch). Another admin's lock is never
   * stealable — takeover on it degrades to a normal blocked answer. */
  takeover?: boolean;
};

export type ActiveLock = LockHolder & {
  leaseId: string | null;
};

export const lockKey = (model: string, documentId: string) =>
  `${model}:${documentId}`;

export const displayName = (user: AdminUserLike): string => {
  const full = [user.firstname, user.lastname]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  return full || user.username || user.email || `Admin #${user.id}`;
};

type LockRow = {
  id: number;
  adminUserId: number;
  leaseId?: string | null;
  holderName: string;
  expiresAt: string;
};

const isActive = (row: LockRow, now: number) =>
  new Date(row.expiresAt).getTime() > now;

/** How many lost races (guarded update / unique-key insert) acquire retries
 * before giving up. Two concurrent editors settle in one retry; hitting the
 * bound means something is systematically wrong and deserves a real error
 * rather than an infinite loop. */
const MAX_ACQUIRE_ATTEMPTS = 3;

/** Only a unique-key collision means "someone inserted between our read and
 * write". Everything else (connection loss, validation, disk) is a genuine
 * failure that must surface, not be retried as if it were a race. */
const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23505') return true; // Postgres unique_violation
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return true;
  }
  return /unique/i.test(String((error as Error | null)?.message ?? ''));
};

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const lockQuery = () => strapi.db.query(LOCK_UID);
  const cancellationQuery = () => strapi.db.query(CANCELLATION_UID);

  const cancelled = async (leaseId: string, now = Date.now()) => {
    const row = (await cancellationQuery().findOne({
      where: { leaseId },
    })) as { expiresAt: string } | null;
    return Boolean(row && new Date(row.expiresAt).getTime() > now);
  };

  const finishAcquire = async (
    key: string,
    leaseId: string,
    user: AdminUserLike,
    expiresAt: string,
  ): Promise<AcquireResult> => {
    if (!(await cancelled(leaseId))) return { acquired: true, expiresAt };
    await lockQuery().deleteMany({
      where: { key, adminUserId: user.id, leaseId },
    });
    return { acquired: false, cancelled: true };
  };

  // A single type is locked under one fixed pseudo id — callers OMIT the
  // documentId entirely (and any value they do pass is ignored). Resolving
  // HERE — nowhere else — makes this service the only place that knows the
  // pseudo id, so the panel and the enforcement middleware cannot drift onto
  // different keys; a caller-side mapping would otherwise be told "acquired"
  // for a key the save guard never consults.
  const normalizeDocumentId = (model: string, documentId?: string) => {
    if ((strapi.getModel(model as any) as any)?.kind === 'singleType') {
      return SINGLE_TYPE_LOCK_DOCUMENT_ID;
    }
    if (typeof documentId !== 'string' || documentId === '') {
      throw new Error(
        `record-lock: documentId is required for collection type ${model}`,
      );
    }
    return documentId;
  };

  const asHolder = (row: LockRow, user: AdminUserLike) => ({
    acquired: false as const,
    holder: {
      adminUserId: row.adminUserId,
      holderName: row.holderName,
      expiresAt: row.expiresAt,
    },
    self: row.adminUserId === user.id,
  });

  return {
    /**
     * Acquire or refresh the lock on `model:documentId` for `user`. Returns
     * the current holder when someone else actively holds it — that is not an
     * error, it is the answer the edit view renders as "come back later".
     *
     * One bounded loop instead of recursion: every attempt re-reads the row
     * and runs the SAME triage, so the holder/lease semantics live in exactly
     * one place, a lost race retries at most MAX_ACQUIRE_ATTEMPTS times
     * instead of recursing unboundedly, and only a unique-key collision is
     * treated as a race — any other create() failure is a real error and
     * surfaces.
     */
    async acquire(
      model: string,
      documentId: string | undefined,
      leaseId: string,
      user: AdminUserLike,
      { takeover = false }: AcquireOptions = {},
    ): Promise<AcquireResult> {
      const lockDocumentId = normalizeDocumentId(model, documentId);
      const key = lockKey(model, lockDocumentId);

      for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
        const now = Date.now();
        const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();

        if (attempt === 0) {
          // Opportunistic sweep: both tables only ever hold sessions active
          // right now, so keep it that way instead of accreting dead rows.
          await lockQuery().deleteMany({
            where: { expiresAt: { $lt: new Date(now).toISOString() } },
          });
          await cancellationQuery().deleteMany({
            where: { expiresAt: { $lt: new Date(now).toISOString() } },
          });
        }

        if (await cancelled(leaseId, now)) {
          return { acquired: false, cancelled: true };
        }

        const existing = (await lockQuery().findOne({
          where: { key },
        })) as LockRow | null;

        if (
          existing &&
          isActive(existing, now) &&
          (existing.adminUserId !== user.id || existing.leaseId !== leaseId)
        ) {
          // Another lease holds the entry. The one sanctioned steal is an
          // EXPLICIT takeover of the same admin's own lease-mate (the tab a
          // page reload orphaned); another admin's lock is never stealable.
          const sanctionedTakeover =
            takeover && existing.adminUserId === user.id;
          if (!sanctionedTakeover) return asHolder(existing, user);
        }

        if (existing) {
          // Refresh this tab's lease, or take over an expired / own one.
          // Guard on the holder and lease we just read so a concurrent
          // takeover cannot be overwritten unnoticed. leaseId may be absent
          // only on a lock row from before this field was deployed; such
          // rows expire within 90 seconds.
          const updated = await lockQuery().update({
            where: {
              id: existing.id,
              adminUserId: existing.adminUserId,
              ...(existing.leaseId ? { leaseId: existing.leaseId } : {}),
            },
            data: {
              adminUserId: user.id,
              leaseId,
              holderName: displayName(user),
              expiresAt,
            },
          });
          if (updated) return finishAcquire(key, leaseId, user, expiresAt);
          continue; // lost the guarded update — re-read and re-triage
        }

        try {
          await lockQuery().create({
            data: {
              key,
              model,
              entryDocumentId: lockDocumentId,
              adminUserId: user.id,
              leaseId,
              holderName: displayName(user),
              expiresAt,
            },
          });
          return finishAcquire(key, leaseId, user, expiresAt);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          continue; // lost the insert race — re-read and re-triage
        }
      }

      throw new Error(
        `record-lock: gave up acquiring ${key} after ${MAX_ACQUIRE_ATTEMPTS} raced attempts`,
      );
    },

    /** Release the lock — only if this exact user+tab lease owns it.
     *
     * Cancellation is persisted first in its own lease-keyed table. This also
     * fences a blocked tab whose cleanup happens while another lease owns the
     * entry; if its earlier acquire resumes after that owner leaves, it still
     * cannot create an orphan. */
    async release(
      model: string,
      documentId: string | undefined,
      leaseId: string,
      user: AdminUserLike,
    ): Promise<boolean> {
      const now = Date.now();
      const lockDocumentId = normalizeDocumentId(model, documentId);
      const key = lockKey(model, lockDocumentId);
      const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();
      try {
        await cancellationQuery().create({
          data: { leaseId, expiresAt },
        });
      } catch (error) {
        const existingCancellation = await cancellationQuery().findOne({
          where: { leaseId },
        });
        if (!existingCancellation) throw error;
      }
      const result = await lockQuery().deleteMany({
        where: { key, adminUserId: user.id, leaseId },
      });
      return result.count > 0;
    },

    /** The active (non-expired) holder of `model:documentId`, or null. */
    async activeHolder(
      model: string,
      documentId: string | undefined,
    ): Promise<ActiveLock | null> {
      const row = (await lockQuery().findOne({
        where: { key: lockKey(model, normalizeDocumentId(model, documentId)) },
      })) as LockRow | null;
      if (!row || !isActive(row, Date.now())) return null;
      return {
        adminUserId: row.adminUserId,
        leaseId: row.leaseId ?? null,
        holderName: row.holderName,
        expiresAt: row.expiresAt,
      };
    },
  };
};
