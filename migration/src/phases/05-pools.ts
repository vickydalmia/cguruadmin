import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { setPoolMapping, setPoolNameMapping } from "../utils/id-maps.js";
import { generateDocumentId, getEntityIdByDocumentId } from "../utils/strapi-insert.js";
import { clean } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";

export async function runPools(): Promise<void> {
  logger.info("=== Phase 5: Unique Coupon Pools Migration ===");

  // Check if wp_uc_coupons exists
  const tableCheck = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'wp_uc_coupons'
  `);

  if (!tableCheck[0]?.c) {
    logger.warn("wp_uc_coupons table not found. Skipping pools migration.");
    return;
  }

  const pools = await wpQuery<{
    id: number;
    name: string;
    total_codes: number;
    used_codes: number;
  }>(`
    SELECT
      uc.id,
      uc.name,
      (SELECT COUNT(*) FROM wp_uc_codes c WHERE c.coupon_id = uc.id) AS total_codes,
      (SELECT COUNT(*) FROM wp_uc_codes c WHERE c.coupon_id = uc.id AND c.is_used = 1) AS used_codes
    FROM wp_uc_coupons uc
    ORDER BY uc.id
  `);

  logger.info(`Found ${pools.length} unique coupon pools`);

  let inserted = 0;
  for (const pool of pools) {
    const documentId = generateDocumentId(`pool:${pool.id}`);

    try {
      const result = await pgQuery<{ id: number }>(
        `INSERT INTO "unique_coupon_pools" (
          "document_id", "name", "total_codes", "used_codes",
          "created_at", "updated_at", "published_at", "locale"
        ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), $5)
        ON CONFLICT ("document_id") DO NOTHING
        RETURNING id`,
        [documentId, clean(pool.name) || pool.name, pool.total_codes, pool.used_codes, null]
      );

      const entityId =
        result[0]?.id ?? (await getEntityIdByDocumentId("unique_coupon_pools", documentId));
      if (entityId) {
        const ref = {
          id: entityId,
          documentId,
          type: "api::unique-coupon-pool.unique-coupon-pool",
          table: "unique_coupon_pools",
        };
        setPoolMapping(pool.id, ref);
        setPoolNameMapping(pool.name, ref);
        inserted++;
      }
    } catch (err: any) {
      logger.error(
        `Failed to insert pool ${pool.id} (${pool.name}): ${err.message}`
      );
    }
  }

  logger.info(`Pools migration complete: ${inserted} inserted`);
}
