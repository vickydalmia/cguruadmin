// PostgreSQL QUERIES for the unique-coupon service: table names, the atomic
// claim/replay/exhaustion SQL, and the shared row helpers. Redemption lives
// in ./redeem-code, bulk import in ./import-codes, stats in ./pool-stats.
import type { Knex } from 'knex';

export interface PoolRow {
  id: number;
  document_id: string;
  name: string;
  total_codes: number;
  used_codes: number;
}

export const UNIQUE_CODES_TABLE = 'unique_codes';
export const POOLS_TABLE = 'unique_coupon_pools';
export const POOL_LINK_TABLE = 'unique_codes_pool_lnk';
export const POOL_LINK_CODE_COLUMN = 'unique_code_id';
export const POOL_LINK_POOL_COLUMN = 'unique_coupon_pool_id';

export const POSTGRES_UNIQUE_VIOLATION = '23505';

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
export const CLAIM_CODE_SQL = `
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
export const CLAIMED_BY_TOKEN_SQL = `
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
export const HAS_UNUSED_CODE_SQL = `
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
export const MARK_POOL_EXHAUSTED_SQL = `
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
export async function resolvePool(
  knex: Knex,
  poolDocumentId: string,
  columns: (keyof PoolRow)[] = ['id', 'name'],
): Promise<Pick<PoolRow, (typeof columns)[number]> | undefined> {
  return knex(POOLS_TABLE)
    .where({ document_id: poolDocumentId })
    .select(columns)
    .first();
}

export function isPostgres(knex: any): boolean {
  const client = knex?.client?.config?.client ?? '';
  return ['pg', 'postgres', 'postgresql'].includes(client);
}

export function requirePostgres(knex: any): void {
  if (!isPostgres(knex)) {
    throw new Error(
      'unique-code import and redemption require PostgreSQL',
    );
  }
}

export function codesForPool(knex: any, poolId: number) {
  return knex(`${UNIQUE_CODES_TABLE} as unique_code`)
    .join(
      `${POOL_LINK_TABLE} as pool_link`,
      `pool_link.${POOL_LINK_CODE_COLUMN}`,
      'unique_code.id',
    )
    .where(`pool_link.${POOL_LINK_POOL_COLUMN}`, poolId);
}
