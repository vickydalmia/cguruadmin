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
 * own lock is a guarded UPDATE (id + previous holder), so two simultaneous
 * takeovers cannot both succeed silently.
 */

import type { Core } from '@strapi/strapi';

const LOCK_UID = 'api::record-lock.record-lock';

/** How long a lock survives without a heartbeat. The panel beats every
 * 30 s, so two missed beats (backgrounded tab, flaky wifi) keep the lock. */
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
  holderName: string;
  expiresAt: string;
};

const isActive = (row: LockRow, now: number) =>
  new Date(row.expiresAt).getTime() > now;

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const lockQuery = () => strapi.db.query(LOCK_UID);

  return {
  /**
   * Acquire or refresh the lock on `model:documentId` for `user`. Returns the
   * current holder when someone ELSE actively holds it — that is not an
   * error, it is the answer the edit view renders as "come back later".
   */
  async acquire(
    model: string,
    documentId: string,
    user: AdminUserLike,
  ): Promise<AcquireResult> {
    const now = Date.now();
    const key = lockKey(model, documentId);
    const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();

    // Opportunistic sweep: the table only ever holds entries being edited
    // right now, so keep it that way instead of accreting dead rows.
    await lockQuery().deleteMany({
      where: { expiresAt: { $lt: new Date(now).toISOString() } },
    });

    const existing = (await lockQuery().findOne({
      where: { key },
    })) as LockRow | null;

    if (existing && isActive(existing, now) && existing.adminUserId !== user.id) {
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
      // Refresh own lock, or take over an expired one. Guard on the holder we
      // just read so a concurrent takeover cannot be overwritten unnoticed.
      const updated = await lockQuery().update({
        where: { id: existing.id, adminUserId: existing.adminUserId },
        data: {
          adminUserId: user.id,
          holderName: displayName(user),
          expiresAt,
        },
      });
      if (updated) return { acquired: true, expiresAt };
      // Lost the takeover race — whoever won is the holder now.
      return this.acquire(model, documentId, user);
    }

    try {
      await lockQuery().create({
        data: {
          key,
          model,
          entryDocumentId: documentId,
          adminUserId: user.id,
          holderName: displayName(user),
          expiresAt,
        },
      });
      return { acquired: true, expiresAt };
    } catch (error) {
      // Unique-key collision: someone inserted between our read and write.
      const holder = await this.activeHolder(model, documentId);
      if (holder && holder.adminUserId !== user.id) {
        return { acquired: false, holder };
      }
      if (holder) return { acquired: true, expiresAt: holder.expiresAt };
      throw error;
    }
  },

  /** Release the lock — only if `user` is the one holding it. */
  async release(
    model: string,
    documentId: string,
    user: AdminUserLike,
  ): Promise<void> {
    await lockQuery().deleteMany({
      where: { key: lockKey(model, documentId), adminUserId: user.id },
    });
  },

  /** The active (non-expired) holder of `model:documentId`, or null. */
  async activeHolder(
    model: string,
    documentId: string,
  ): Promise<LockHolder | null> {
    const row = (await lockQuery().findOne({
      where: { key: lockKey(model, documentId) },
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
