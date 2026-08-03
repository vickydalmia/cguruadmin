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
 * tabs belong to the same admin user.
 */

import type { Core } from '@strapi/strapi';

import { SINGLE_TYPE_LOCK_DOCUMENT_ID } from '../../../constants/record-lock';

const LOCK_UID = 'api::record-lock.record-lock';

/** How long a lock survives without a heartbeat. The panel beats every 20 s
 * while holding (10 s while waiting behind someone else's lock) and aborts a
 * hung acquire at 15 s, so several missed beats (backgrounded-tab timer
 * throttling, flaky wifi) still keep the lock. Retune alongside
 * HEARTBEAT_MS / BLOCKED_RETRY_MS / ACQUIRE_TIMEOUT_MS in
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
  | { acquired: false; holder: LockHolder };

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

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const lockQuery = () => strapi.db.query(LOCK_UID);

  // A single type is locked under one fixed pseudo id no matter what
  // documentId the caller passes (it does have a real one server-side).
  // Normalizing HERE — not in the callers — keeps the panel and the
  // enforcement middleware on the same key by construction; a caller passing
  // the real id would otherwise be told "acquired" for a key the save guard
  // never consults.
  const normalizeDocumentId = (model: string, documentId: string) =>
    (strapi.getModel(model as any) as any)?.kind === 'singleType'
      ? SINGLE_TYPE_LOCK_DOCUMENT_ID
      : documentId;

  return {
    /**
     * Acquire or refresh the lock on `model:documentId` for `user`. Returns the
     * current holder when someone ELSE actively holds it — that is not an
     * error, it is the answer the edit view renders as "come back later".
     */
    async acquire(
      model: string,
      documentId: string,
      leaseId: string,
      user: AdminUserLike,
    ): Promise<AcquireResult> {
      const now = Date.now();
      const lockDocumentId = normalizeDocumentId(model, documentId);
      const key = lockKey(model, lockDocumentId);
      const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();

      // Opportunistic sweep: the table only ever holds entries being edited
      // right now, so keep it that way instead of accreting dead rows.
      await lockQuery().deleteMany({
        where: { expiresAt: { $lt: new Date(now).toISOString() } },
      });

      const existing = (await lockQuery().findOne({
        where: { key },
      })) as LockRow | null;

      if (
        existing &&
        isActive(existing, now) &&
        (existing.adminUserId !== user.id || existing.leaseId !== leaseId)
      ) {
        return {
          acquired: false,
          holder: {
            adminUserId: existing.adminUserId,
            holderName: existing.holderName,
            expiresAt: existing.expiresAt,
          },
        };
      }

      if (existing) {
        // Refresh this tab's lease, or take over an expired one. Guard on the
        // holder and lease we just read so a concurrent takeover cannot be
        // overwritten unnoticed. leaseId may be absent only on a lock row from
        // before this field was deployed; such rows expire within 90 seconds.
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
        if (updated) return { acquired: true, expiresAt };
        // Lost the takeover race — whoever won is the holder now.
        return this.acquire(model, documentId, leaseId, user);
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
        return { acquired: true, expiresAt };
      } catch (error) {
        // Unique-key collision: someone inserted between our read and write.
        const raced = (await lockQuery().findOne({
          where: { key },
        })) as LockRow | null;
        if (raced && isActive(raced, Date.now())) {
          if (raced.adminUserId === user.id && raced.leaseId === leaseId) {
            return { acquired: true, expiresAt: raced.expiresAt };
          }
          return {
            acquired: false,
            holder: {
              adminUserId: raced.adminUserId,
              holderName: raced.holderName,
              expiresAt: raced.expiresAt,
            },
          };
        }
        if (raced) return this.acquire(model, documentId, leaseId, user);
        throw error;
      }
    },

    /** Release the lock — only if `user` is the one holding it. */
    async release(
      model: string,
      documentId: string,
      leaseId: string,
      user: AdminUserLike,
    ): Promise<boolean> {
      const result = await lockQuery().deleteMany({
        where: {
          key: lockKey(model, normalizeDocumentId(model, documentId)),
          adminUserId: user.id,
          leaseId,
        },
      });
      return result.count > 0;
    },

    /** The active (non-expired) holder of `model:documentId`, or null. */
    async activeHolder(
      model: string,
      documentId: string,
    ): Promise<LockHolder | null> {
      const row = (await lockQuery().findOne({
        where: { key: lockKey(model, normalizeDocumentId(model, documentId)) },
      })) as LockRow | null;
      if (!row || !isActive(row, Date.now())) return null;
      return {
        adminUserId: row.adminUserId,
        holderName: row.holderName,
        expiresAt: row.expiresAt,
      };
    },
  };
};
