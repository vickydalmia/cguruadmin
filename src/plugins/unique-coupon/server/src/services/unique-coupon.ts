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
   * Redeem one code while holding the existing pool row lock. Import and
   * redemption use the same lock, so counters and stock cannot race. The code
   * remains related through Strapi's unique_codes_pool_lnk table; no duplicate
   * pool id is stored on unique_codes.
   */
  async redeemCode(poolDocumentId: string, maxRetries = 5) {
    const knex = strapi.db.connection;
    requirePostgres(knex);
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const result = await knex.transaction(async (trx: any) => {
          const poolQuery = trx(POOLS_TABLE)
            .where({ document_id: poolDocumentId })
            .select(['id', 'name'])
            .first()
            .forUpdate();
          const pool = await poolQuery;
          if (!pool) {
            return {
              success: false as const,
              error: 'POOL_NOT_FOUND',
              message: 'Coupon pool not found',
            };
          }

          const code = await codesForPool(trx, pool.id)
            .where('unique_code.is_used', false)
            .select('unique_code.*')
            .orderBy('unique_code.id', 'asc')
            .first()
            .forUpdate();

          if (!code) {
            return {
              success: false as const,
              error: 'NO_CODES_AVAILABLE',
              message: 'All coupon codes have been redeemed',
            };
          }

          const updated = await trx(UNIQUE_CODES_TABLE)
            .where({ id: code.id, version: code.version })
            .update({
              is_used: true,
              used_at: new Date(),
              version: code.version + 1,
            });

          if (updated !== 1) {
            const conflict = new Error('unique-code optimistic update conflict');
            (conflict as any).code = 'UNIQUE_CODE_CONFLICT';
            throw conflict;
          }

          await trx(POOLS_TABLE)
            .where({ id: pool.id })
            .increment('used_codes', 1);

          return {
            success: true as const,
            code: code.code,
            poolName: pool.name,
          };
        });

        if (result.success) {
          strapi.log.info(
            `Code redeemed from pool ${result.poolName}: ${result.code.substring(0, 4)}***`,
          );
          return { success: true as const, code: result.code };
        }
        return result;
      } catch (error) {
        strapi.log.error('Unique code redemption error:', error);
        retries++;
        if (retries < maxRetries) await this.delay(50 * retries);
      }
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
