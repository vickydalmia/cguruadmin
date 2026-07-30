import type { Core } from '@strapi/strapi';
import { createId } from '@paralleldrive/cuid2';

interface PoolRow {
  id: number;
  document_id: string;
  name: string;
  total_codes: number;
  used_codes: number;
}

const UNIQUE_CODES_TABLE = 'unique_codes';
const POOLS_TABLE = 'unique_coupon_pools';
const POOL_LINK_TABLE = 'unique_codes_pool_lnk';
const POOL_LINK_CODE_COLUMN = 'unique_code_id';
const POOL_LINK_POOL_COLUMN = 'unique_coupon_pool_id';

/**
 * How long a claim token can still be exchanged for the code it claimed.
 * A reload of the same activation inside this window returns the same code
 * instead of burning another; past it the token is just history, so a leaked
 * activation id is not a permanent read capability for a live code.
 */
const CLAIM_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Claim exactly one unused code from a pool, as a single atomic statement.
 *
 * `SKIP LOCKED` is what makes this concurrent: two simultaneous claimers step
 * over each other's in-flight rows and take DIFFERENT codes instead of queuing
 * behind one lock. Double-issuance is prevented by the `is_used = false` on the
 * outer UPDATE, not by serializing — a row another transaction already took is
 * no longer eligible, so the UPDATE matches nothing and we look again.
 *
 * The subquery is deliberately ONE `EXISTS`, never an OR-of-EXISTS: the wide
 * form inflates the planner's cost estimate enough to trip PG JIT, which is
 * what made public search collapse (see src/api/search/services/search-sql.ts).
 *
 * `ORDER BY uc.id` walks the partial index on unused rows
 * (`unique_codes_unclaimed_idx`), so a 99%-drained pool costs the same per
 * claim as a fresh one. Without that index this scans every spent code.
 */
const CLAIM_CODE_SQL = `
  UPDATE "${UNIQUE_CODES_TABLE}"
     SET is_used = true,
         used_at = ?,
         claim_token = ?,
         version = version + 1
   WHERE id = (
     SELECT uc.id
       FROM "${UNIQUE_CODES_TABLE}" uc
      WHERE uc.is_used = false
        AND EXISTS (
              SELECT 1
                FROM "${POOL_LINK_TABLE}" l
               WHERE l."${POOL_LINK_CODE_COLUMN}" = uc.id
                 AND l."${POOL_LINK_POOL_COLUMN}" = ?
            )
      ORDER BY uc.id
      LIMIT 1
        FOR UPDATE SKIP LOCKED
   )
     AND is_used = false
  RETURNING code`;

/** The code a previous request already claimed for this activation. */
const CLAIMED_BY_TOKEN_SQL = `
  SELECT uc.code
    FROM "${UNIQUE_CODES_TABLE}" uc
    JOIN "${POOL_LINK_TABLE}" l
      ON l."${POOL_LINK_CODE_COLUMN}" = uc.id
   WHERE uc.claim_token = ?
     AND l."${POOL_LINK_POOL_COLUMN}" = ?
     AND uc.used_at > ?
   LIMIT 1`;

/**
 * Distinguishes "this pool is empty" from "every free code is momentarily
 * locked by another claimer". Without it a burst of concurrent clicks would
 * report a healthy pool as exhausted.
 */
const HAS_UNUSED_CODE_SQL = `
  SELECT 1
    FROM "${UNIQUE_CODES_TABLE}" uc
   WHERE uc.is_used = false
     AND EXISTS (
           SELECT 1
             FROM "${POOL_LINK_TABLE}" l
            WHERE l."${POOL_LINK_CODE_COLUMN}" = uc.id
              AND l."${POOL_LINK_POOL_COLUMN}" = ?
         )
   LIMIT 1`;

/**
 * Mark a pool drained — but only if it is STILL drained at the moment of the
 * write.
 *
 * The emptiness check and this stamp are separate statements, and `importCodes`
 * clears `exhausted_at` inside a transaction holding the pool row lock. An
 * import committing between the two would otherwise have its restock
 * overwritten, and the scheduler would expire offers backed by a pool that has
 * stock — until the nightly recount undid it.
 *
 * Re-checking inside the UPDATE closes that: this statement blocks on the
 * import's row lock, then re-evaluates `NOT EXISTS` against the committed
 * codes and declines to stamp.
 */
const MARK_POOL_EXHAUSTED_SQL = `
  UPDATE "${POOLS_TABLE}"
     SET exhausted_at = ?
   WHERE id = ?
     AND exhausted_at IS NULL
     AND NOT EXISTS (
           SELECT 1
             FROM "${UNIQUE_CODES_TABLE}" uc
            WHERE uc.is_used = false
              AND EXISTS (
                    SELECT 1
                      FROM "${POOL_LINK_TABLE}" l
                     WHERE l."${POOL_LINK_CODE_COLUMN}" = uc.id
                       AND l."${POOL_LINK_POOL_COLUMN}" = ?
                  )
         )`;

/**
 * Resolve a pool's internal DB row by its documentId via raw Knex
 * so we get the numeric `id` without fragile type casts.
 */
async function resolvePool(
  knex: ReturnType<Core.Strapi['db']['connection']>,
  poolDocumentId: string,
  columns: (keyof PoolRow)[] = ['id', 'name'],
): Promise<Pick<PoolRow, (typeof columns)[number]> | undefined> {
  return knex(POOLS_TABLE)
    .where({ document_id: poolDocumentId })
    .select(columns)
    .first();
}

function isPostgres(knex: any): boolean {
  const client = knex?.client?.config?.client ?? '';
  return ['pg', 'postgres', 'postgresql'].includes(client);
}

function requirePostgres(knex: any): void {
  if (!isPostgres(knex)) {
    throw new Error(
      'unique-code import and redemption require PostgreSQL',
    );
  }
}

function codesForPool(knex: any, poolId: number) {
  return knex(`${UNIQUE_CODES_TABLE} as unique_code`)
    .join(
      `${POOL_LINK_TABLE} as pool_link`,
      `pool_link.${POOL_LINK_CODE_COLUMN}`,
      'unique_code.id',
    )
    .where(`pool_link.${POOL_LINK_POOL_COLUMN}`, poolId);
}

const uniqueCouponService = ({ strapi }: { strapi: Core.Strapi }) => ({

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
  async redeemCode(
    poolDocumentId: string,
    options: { activationId?: string | null; maxRetries?: number } = {},
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
      if (retries < maxRetries) await this.delay(20 * retries);
    }

    strapi.log.warn(`Max retries (${maxRetries}) exceeded for pool ${poolDocumentId}`);
    return {
      success: false as const,
      error: 'MAX_RETRIES_EXCEEDED',
      message: 'Service temporarily unavailable, please try again',
    };
  },

  /**
   * Bulk import codes into a pool atomically.
   *
   * The existing pool row serializes imports and redemption. Existing codes
   * are resolved through Strapi's relation table; new code rows and relation
   * rows are inserted in the same transaction. PostgreSQL relation/code
   * triggers remain the final boundary for writes outside this service.
   */
  async importCodes(poolDocumentId: string, codes: string[], batchSize = 100) {
    const knex = strapi.db.connection;
    requirePostgres(knex);
    const totalCodes = codes.length;
    const uniqueCodes = [...new Set(codes.map((c) => c.trim()).filter((c) => c))];
    const safeBatchSize = Math.max(1, Math.floor(batchSize));

    return knex.transaction(async (trx) => {
      const poolQuery = trx('unique_coupon_pools')
        .where({ document_id: poolDocumentId })
        .select('id')
        .first()
        .forUpdate();
      const pool = await poolQuery;

      if (!pool) {
        const error = new Error(`Pool not found: ${poolDocumentId}`);
        (error as any).code = 'POOL_NOT_FOUND';
        throw error;
      }

      const existingRows = uniqueCodes.length === 0
        ? []
        : await codesForPool(trx, pool.id)
            .whereIn('unique_code.code', uniqueCodes)
            .select('unique_code.code');
      const existingCodes = new Set(
        existingRows.map((row: { code: string }) => row.code),
      );
      const codesToInsert = uniqueCodes.filter((code) => !existingCodes.has(code));

      let insertedRows = 0;
      for (let i = 0; i < codesToInsert.length; i += safeBatchSize) {
        const now = new Date();
        const batch = codesToInsert.slice(i, i + safeBatchSize).map((code) => ({
          document_id: createId(),
          code,
          is_used: false,
          version: 0,
          created_at: now,
          updated_at: now,
          published_at: now,
          locale: null,
        }));

        const inserted = await trx(UNIQUE_CODES_TABLE)
          .insert(batch)
          .returning(['id', 'code']);
        if (inserted.length > 0) {
          await trx(POOL_LINK_TABLE).insert(
            inserted.map((row: { id: number }) => ({
              [POOL_LINK_CODE_COLUMN]: row.id,
              [POOL_LINK_POOL_COLUMN]: pool.id,
              unique_code_ord: 1,
            })),
          );
          insertedRows += inserted.length;
        }
      }

      if (insertedRows > 0) {
        await trx(POOLS_TABLE)
          .where({ id: pool.id })
          .increment('total_codes', insertedRows);
        // Restocking un-expires the offers this pool feeds; the scheduler
        // notices on its next pass.
        await trx(POOLS_TABLE)
          .where({ id: pool.id })
          .update({ exhausted_at: null });
      }

      return {
        imported: insertedRows,
        skipped: Math.max(0, totalCodes - insertedRows),
        total: totalCodes,
      };
    });
  },

  /**
   * Get pool statistics via direct query for accuracy.
   */
  async getPoolStats(poolDocumentId: string) {
    const knex = strapi.db.connection;

    const pool = await resolvePool(knex, poolDocumentId, ['id', 'name', 'document_id']);
    if (!pool) {
      return null;
    }

    const stats = await codesForPool(knex, pool.id)
      .select(
        knex.raw('COUNT(*) as total'),
        knex.raw(
          'SUM(CASE WHEN ?? = true THEN 1 ELSE 0 END) as used',
          ['unique_code.is_used'],
        ),
      )
      .first();

    const total = parseInt(stats.total) || 0;
    const used = parseInt(stats.used) || 0;

    return {
      documentId: pool.document_id,
      name: pool.name,
      totalCodes: total,
      usedCodes: used,
      availableCodes: total - used,
      utilizationRate: total > 0
        ? ((used / total) * 100).toFixed(2) + '%'
        : '0%',
    };
  },

  delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
});

export default uniqueCouponService;
