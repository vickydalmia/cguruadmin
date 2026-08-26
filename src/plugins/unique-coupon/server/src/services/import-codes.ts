// Bulk IMPORT for the unique-coupon service: transactional insert of new
// codes and relation rows behind the pool row lock. SQL/table helpers live
// in ./unique-coupon-sql.
import type { Core } from '@strapi/strapi';
import { createId } from '@paralleldrive/cuid2';
import {
  POOLS_TABLE,
  POOL_LINK_CODE_COLUMN,
  POOL_LINK_POOL_COLUMN,
  POOL_LINK_TABLE,
  UNIQUE_CODES_TABLE,
  codesForPool,
  requirePostgres,
} from './unique-coupon-sql';

/**
 * Bulk import codes into a pool atomically.
 *
 * The existing pool row serializes imports and redemption. Existing codes
 * are resolved through Strapi's relation table; new code rows and relation
 * rows are inserted in the same transaction. PostgreSQL relation/code
 * triggers remain the final boundary for writes outside this service.
 */
export async function importCodes(
  strapi: Core.Strapi,
  poolDocumentId: string,
  codes: string[],
  batchSize = 100,
) {
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
}
