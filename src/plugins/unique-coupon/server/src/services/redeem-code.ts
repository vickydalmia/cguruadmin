// REDEMPTION for the unique-coupon service: the atomic claim loop with
// activation-id replay, exhaustion marking and bounded retries. SQL lives in
// ./unique-coupon-sql; the service factory in ./unique-coupon delegates here
// and supplies its own `delay` so the retry cadence stays overridable.
import type { Core } from '@strapi/strapi';
import {
  CLAIMED_BY_TOKEN_SQL,
  CLAIM_CODE_SQL,
  HAS_UNUSED_CODE_SQL,
  MARK_POOL_EXHAUSTED_SQL,
  POSTGRES_UNIQUE_VIOLATION,
  requirePostgres,
  resolvePool,
} from './unique-coupon-sql';

/**
 * How long a claim token can still be exchanged for the code it claimed.
 * A reload of the same activation inside this window returns the same code
 * instead of burning another; past it the token is just history, so a leaked
 * activation id is not a permanent read capability for a live code.
 */
const CLAIM_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Draw one code from a pool and mark it used.
 *
 * There is no pool-row lock here on purpose. The previous implementation
 * took `SELECT ... FOR UPDATE` on the pool and bumped `used_codes` in the
 * same transaction, which made every click on a pool queue behind every
 * other click on it — correct, but one redemption at a time. Correctness now
 * comes from the atomic conditional UPDATE in CLAIM_CODE_SQL instead, so
 * concurrent claimers proceed in parallel and still cannot be handed the
 * same code.
 *
 * `used_codes` is no longer maintained here for the same reason: it is one
 * shared row, so writing it per redemption would reintroduce exactly the
 * serialization this removes. It is reconciled from the code rows instead
 * (`recountPools`), and `getPoolStats` already reports live counts.
 *
 * `activationId` makes a draw idempotent for one click: a reload, a bfcache
 * restore, or a retried request replays the code that activation already
 * claimed rather than burning another. A genuinely new click carries a new
 * activation id and so draws a new code.
 */
export async function redeemCode(
  strapi: Core.Strapi,
  poolDocumentId: string,
  options: { activationId?: string | null; maxRetries?: number } = {},
  delay: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const knex = strapi.db.connection;
  requirePostgres(knex);
  const activationId = options.activationId?.trim() || null;
  const maxRetries = options.maxRetries ?? 5;

  const pool = await resolvePool(knex, poolDocumentId);
  if (!pool) {
    return {
      success: false as const,
      error: 'POOL_NOT_FOUND',
      message: 'Coupon pool not found',
    };
  }

  const replay = async (): Promise<string | null> => {
    if (!activationId) return null;
    const cutoff = new Date(Date.now() - CLAIM_REPLAY_WINDOW_MS);
    const found = await knex.raw(CLAIMED_BY_TOKEN_SQL, [
      activationId,
      pool.id,
      cutoff,
    ]);
    const code = found?.rows?.[0]?.code;
    return typeof code === 'string' ? code : null;
  };

  const replayed = await replay();
  if (replayed) {
    return { success: true as const, code: replayed };
  }

  // Normally the activation id, but dropped to null once we learn it belongs
  // to a claim too old to replay — see the conflict handler below.
  let claimToken = activationId;

  let retries = 0;
  while (retries < maxRetries) {
    try {
      const claimed = await knex.raw(CLAIM_CODE_SQL, [
        new Date(),
        claimToken,
        pool.id,
      ]);
      const code = claimed?.rows?.[0]?.code;
      if (typeof code === 'string') {
        strapi.log.info(
          `Code redeemed from pool ${pool.name}: ${code.substring(0, 4)}***`,
        );
        return { success: true as const, code };
      }

      // Nothing was updated. Either the pool is genuinely out of stock, or
      // every free code is locked by a concurrent claimer this instant —
      // only the second is worth retrying.
      const available = await knex.raw(HAS_UNUSED_CODE_SQL, [pool.id]);
      if (!available?.rows?.length) {
        // Mark the pool so the scheduler can expire the offers pointing at
        // it. This is the drained edge, not the per-redemption path, so
        // writing the shared pool row here costs nothing in throughput. The
        // statement re-checks emptiness itself, so a restock that lands
        // between the probe above and this write is not clobbered.
        await knex.raw(MARK_POOL_EXHAUSTED_SQL, [
          new Date(),
          pool.id,
          pool.id,
        ]);

        // The pool draining and THIS activation claiming its final code are
        // not mutually exclusive: a concurrent request for the same
        // activation may have taken the last row after our replay() at the
        // top missed. The 23505 handler already replays for that race; this
        // path must too, or the winner's caller gets the code while every
        // concurrent twin is told the pool is empty.
        const lastCode = await replay();
        if (lastCode) {
          return { success: true as const, code: lastCode };
        }

        return {
          success: false as const,
          error: 'NO_CODES_AVAILABLE',
          message: 'All coupon codes have been redeemed',
        };
      }
    } catch (error) {
      // The partial unique index on claim_token rejected this token. Two
      // cases, and they need opposite handling.
      if ((error as any)?.code === POSTGRES_UNIQUE_VIOLATION) {
        // (a) A concurrent request for the same activation won the race. A
        // 23505 only fires against a COMMITTED row, so the winner's code is
        // readable now and is the right answer for both callers.
        const raced = await replay();
        if (raced) return { success: true as const, code: raced };

        // (b) The token belongs to a claim older than the replay window, so
        // nothing can be replayed — but the index keeps rejecting it
        // forever. Retrying with the same token would just burn every
        // attempt and hand the visitor a 503. Drop the token and draw a
        // fresh code: this activation is simply no longer idempotent.
        claimToken = null;
      } else {
        strapi.log.error('Unique code redemption error:', error);
      }
    }

    retries++;
    if (retries < maxRetries) await delay(20 * retries);
  }

  strapi.log.warn(`Max retries (${maxRetries}) exceeded for pool ${poolDocumentId}`);
  return {
    success: false as const,
    error: 'MAX_RETRIES_EXCEEDED',
    message: 'Service temporarily unavailable, please try again',
  };
}
