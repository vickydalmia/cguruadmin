// POOL STATS for the unique-coupon service: live counts read straight from
// the code rows. SQL/table helpers live in ./unique-coupon-sql.
import type { Core } from '@strapi/strapi';
import { codesForPool, resolvePool } from './unique-coupon-sql';

/**
 * Get pool statistics via direct query for accuracy.
 */
export async function getPoolStats(strapi: Core.Strapi, poolDocumentId: string) {
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
}
