import type { Core } from '@strapi/strapi';
import { createId } from '@paralleldrive/cuid2';

interface PoolRow {
  id: number;
  document_id: string;
  name: string;
  total_codes: number;
  used_codes: number;
}

/**
 * Resolve a pool's internal DB row by its documentId via raw Knex
 * so we get the numeric `id` without fragile type casts.
 */
async function resolvePool(
  knex: ReturnType<Core.Strapi['db']['connection']>,
  poolDocumentId: string,
  columns: (keyof PoolRow)[] = ['id', 'name'],
): Promise<Pick<PoolRow, (typeof columns)[number]> | undefined> {
  return knex('unique_coupon_pools')
    .where({ document_id: poolDocumentId })
    .select(columns)
    .first();
}

function isPostgres(knex: any): boolean {
  const client = knex?.client?.config?.client ?? '';
  return ['pg', 'postgres', 'postgresql'].includes(client);
}

function isSqlite(knex: any): boolean {
  const client = knex?.client?.config?.client ?? '';
  return ['sqlite', 'sqlite3', 'better-sqlite3'].includes(client);
}

function countValue(row: any, column = 'count'): number {
  return Number(row?.[column] ?? 0) || 0;
}

const uniqueCouponService = ({ strapi }: { strapi: Core.Strapi }) => ({

  /**
   * Redeem a unique coupon code with row-level locking.
   * Uses PostgreSQL advisory lock when available, otherwise FOR UPDATE SKIP LOCKED.
   */
  async redeemCode(poolDocumentId: string, maxRetries = 5) {
    const knex = strapi.db.connection;
    let retries = 0;
    const useAdvisoryLock = isPostgres(knex);

    // The non-Postgres fallback below issues a raw FOR UPDATE SKIP LOCKED,
    // which SQLite cannot parse — every attempt would error until the loop
    // gives up with MAX_RETRIES_EXCEEDED. Fail fast with the real reason.
    if (!useAdvisoryLock && isSqlite(knex)) {
      throw new Error(
        'unique-code redemption requires PostgreSQL or MySQL 8+ (SQLite does not support FOR UPDATE SKIP LOCKED)',
      );
    }

    const pool = await resolvePool(knex, poolDocumentId, ['id', 'name']);
    if (!pool) {
      return { success: false as const, error: 'POOL_NOT_FOUND', message: 'Coupon pool not found' };
    }

    while (retries < maxRetries) {
      const trx = await knex.transaction();

      try {
        if (useAdvisoryLock) {
          const lockResult = await trx.raw(
            'SELECT pg_try_advisory_xact_lock(?)',
            [pool.id],
          );
          if (!lockResult.rows[0].pg_try_advisory_xact_lock) {
            await trx.rollback();
            retries++;
            await this.delay(50 * retries);
            continue;
          }
        }

        let code: any;

        if (useAdvisoryLock) {
          code = await trx('unique_codes')
            .where({ pool_id: pool.id, is_used: false })
            .first();
        } else {
          // FOR UPDATE SKIP LOCKED works on PostgreSQL and MySQL 8+
          const result = await trx.raw(
            'SELECT * FROM unique_codes WHERE pool_id = ? AND is_used = false LIMIT 1 FOR UPDATE SKIP LOCKED',
            [pool.id],
          );
          code = result?.rows?.[0] ?? result?.[0]?.[0];
        }

        if (!code) {
          await trx.rollback();
          return {
            success: false as const,
            error: 'NO_CODES_AVAILABLE',
            message: 'All coupon codes have been redeemed',
          };
        }

        const updated = await trx('unique_codes')
          .where({ id: code.id, version: code.version })
          .update({
            is_used: true,
            used_at: new Date(),
            version: code.version + 1,
          });

        if (updated === 0) {
          await trx.rollback();
          retries++;
          continue;
        }

        await trx('unique_coupon_pools')
          .where({ id: pool.id })
          .increment('used_codes', 1);

        await trx.commit();

        strapi.log.info(`Code redeemed from pool ${pool.name}: ${code.code.substring(0, 4)}***`);
        return { success: true as const, code: code.code };

      } catch (error) {
        await trx.rollback();
        strapi.log.error('Unique code redemption error:', error);
        retries++;
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
   * The pool row serializes concurrent imports while the database's composite
   * unique index on (pool_id, code) is the final safety boundary. Existing
   * codes are ignored.
   *
   * The pool row lock also blocks redeemCode's counter increment, so the work
   * held under it must stay O(chunk), not O(pool size): on Postgres the driver
   * reports how many rows each INSERT .. ON CONFLICT DO NOTHING actually wrote
   * (pg's rowCount excludes ignored conflicts), and total_codes is incremented
   * by that sum. Other dialects don't surface that count through knex's insert
   * response, so they fall back to a before/after COUNT(*). used_codes is not
   * touched here — an import never changes usage, and redeemCode maintains it.
   */
  async importCodes(poolDocumentId: string, codes: string[], batchSize = 100) {
    const knex = strapi.db.connection;
    const totalCodes = codes.length;
    const uniqueCodes = [...new Set(codes.map((c) => c.trim()).filter((c) => c))];
    const safeBatchSize = Math.max(1, Math.floor(batchSize));

    return knex.transaction(async (trx) => {
      const poolQuery = trx('unique_coupon_pools')
        .where({ document_id: poolDocumentId })
        .select('id')
        .first();
      if (!isSqlite(trx)) poolQuery.forUpdate();
      const pool = await poolQuery;

      if (!pool) {
        const error = new Error(`Pool not found: ${poolDocumentId}`);
        (error as any).code = 'POOL_NOT_FOUND';
        throw error;
      }

      const countInsertedRows = isPostgres(trx);

      const before = countInsertedRows
        ? undefined
        : await trx('unique_codes')
            .where({ pool_id: pool.id })
            .count({ count: '*' })
            .first();

      let insertedRows = 0;
      for (let i = 0; i < uniqueCodes.length; i += safeBatchSize) {
        const now = new Date();
        const batch = uniqueCodes.slice(i, i + safeBatchSize).map((code) => ({
          document_id: createId(),
          code,
          pool_id: pool.id,
          is_used: false,
          version: 0,
          created_at: now,
          updated_at: now,
        }));

        const result = await trx('unique_codes')
          .insert(batch)
          .onConflict(['pool_id', 'code'])
          .ignore();

        // knex + pg returns the driver's Result for an INSERT without
        // RETURNING; its rowCount counts only the rows actually written.
        if (countInsertedRows) {
          insertedRows += Number((result as any)?.rowCount ?? 0) || 0;
        }
      }

      let imported: number;
      if (countInsertedRows) {
        imported = insertedRows;
        if (imported > 0) {
          await trx('unique_coupon_pools')
            .where({ id: pool.id })
            .increment('total_codes', imported);
        }
      } else {
        const after = await trx('unique_codes')
          .where({ pool_id: pool.id })
          .count({ count: '*' })
          .first();
        imported = Math.max(0, countValue(after) - countValue(before));
        await trx('unique_coupon_pools')
          .where({ id: pool.id })
          .update({ total_codes: countValue(after) });
      }

      return {
        imported,
        skipped: Math.max(0, totalCodes - imported),
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

    const stats = await knex('unique_codes')
      .where({ pool_id: pool.id })
      .select(
        knex.raw('COUNT(*) as total'),
        knex.raw('SUM(CASE WHEN is_used = true THEN 1 ELSE 0 END) as used'),
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
