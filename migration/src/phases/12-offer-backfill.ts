import pLimit from "p-limit";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { ensurePostMapping } from "../utils/id-maps.js";
import { replaceOfferTaxonomyRelations } from "../utils/offer-relations.js";
import { logger } from "../utils/logger.js";
import { parseAcfTermId } from "../utils/acf.js";

/**
 * Phase 12 — Fold the WordPress ACF `deal_store` postmeta (a store term ID,
 * possibly PHP-serialized) into the deal's STORES TAXONOMY.
 *
 * This used to populate a separate `deal.primaryStore` manyToOne relation.
 * That field has been removed: it duplicated a store the taxonomy already
 * carried, and every consumer had to query `$or: [{stores}, {primaryStore}]`
 * to avoid missing deals. The frontend now resolves a Deal's owning entity as
 * stores[0] → brands[0], so writing the ACF store first in `stores` preserves
 * the same merchant without a duplicate relation.
 *
 * This phase intentionally rebuilds the complete four-taxonomy relation set,
 * not just the ACF row. That makes it safe when ACF ownership changes or is
 * cleared: stale links disappear and ACF store → Yoast primary → remaining WP
 * term order converges to the same state as a clean phase-08 import.
 */
export async function runOfferBackfill(): Promise<void> {
  logger.info("=== Phase 12: Offer Backfill (ACF deal_store → stores taxonomy) ===");

  // Guard against stale ID maps: if the Strapi tables are empty, the persisted
  // maps belong to a different database (e.g. after switching
  // PG_CONNECTION_STRING) and every row-id lookup would fail with FK errors.
  const [{ count: dealCount }] = await pgQuery<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM deals"
  );
  if (Number(dealCount) === 0) {
    throw new Error(
      "Strapi `deals` table is empty but checkpoints/ID maps exist from a previous run " +
        "against a different database. Run a full clean migration instead: npm run migrate -- --clean"
    );
  }

  // Include every migrated Deal, including one whose deal_store was removed;
  // otherwise an old ACF owner could never be deleted during a re-import.
  const rows = await wpQuery<{
    post_id: number;
    deal_store: string | null;
  }>(`
    SELECT p.ID AS post_id,
           MAX(CASE WHEN store_meta.meta_key = 'deal_store'
                    THEN store_meta.meta_value END) AS deal_store
    FROM wp_posts p
    JOIN wp_postmeta deal_meta
      ON deal_meta.post_id = p.ID
     AND deal_meta.meta_key = 'is_deal'
     AND deal_meta.meta_value = 'yes'
    LEFT JOIN wp_postmeta store_meta
      ON store_meta.post_id = p.ID
     AND store_meta.meta_key = 'deal_store'
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
    GROUP BY p.ID
    ORDER BY p.ID
  `);

  logger.info(`Found ${rows.length} migrated Deal post(s) to reconcile`);
  const postIds = rows.map((row) => row.post_id);
  const placeholders = postIds.map(() => "?").join(",");
  const relationRows = postIds.length
    ? await wpQuery<{ object_id: number; term_id: number }>(
        `SELECT tr.object_id, tt.term_id
           FROM wp_term_relationships tr
           JOIN wp_term_taxonomy tt
             ON tr.term_taxonomy_id = tt.term_taxonomy_id
            AND tt.taxonomy = 'category'
          WHERE tr.object_id IN (${placeholders})
          ORDER BY tr.object_id, tr.term_order, tt.term_id`,
        postIds,
      )
    : [];
  const relationsByPost = new Map<number, number[]>();
  for (const relation of relationRows) {
    const ids = relationsByPost.get(relation.object_id) ?? [];
    ids.push(relation.term_id);
    relationsByPost.set(relation.object_id, ids);
  }

  let primaryTerms = new Map<number, number>();
  if (postIds.length > 0) {
    try {
      const primaryRows = await wpQuery<{ post_id: number; term_id: number }>(
        `SELECT post_id, term_id
           FROM wp_yoast_primary_term
          WHERE post_id IN (${placeholders})
            AND taxonomy = 'category'`,
        postIds,
      );
      primaryTerms = new Map(
        primaryRows.map((row) => [row.post_id, row.term_id]),
      );
    } catch {
      logger.warn("wp_yoast_primary_term not available for offer backfill");
    }
  }

  let reconciled = 0;
  let skipped = 0;
  const limit = pLimit(20);
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        try {
          const ref = await ensurePostMapping(row.post_id, "deals");
          if (!ref) {
            skipped++;
            return;
          }
          await replaceOfferTaxonomyRelations("deals", ref.id, {
            termIds: relationsByPost.get(row.post_id) ?? [],
            primaryTermId: primaryTerms.get(row.post_id),
            acfStoreTermId: parseAcfTermId(row.deal_store),
          });
          reconciled++;
        } catch (err: any) {
          skipped++;
          logger.error(
            `Failed to reconcile Deal ${row.post_id}: ${err.message}`,
          );
        }
      }),
    ),
  );

  logger.info(
    `Offer backfill complete: ${reconciled} Deal taxonomy set(s) reconciled, ` +
      `${skipped} skipped`,
  );
  if (skipped > 0) {
    throw new Error(
      `${skipped} Deal taxonomy set(s) failed reconciliation; see the WordPress post IDs above`,
    );
  }

  await markLatestStoreCouponsRecommended();
}

/**
 * Badge each store's newest live coupon as "Recommended".
 *
 * WHY: the site sorts an entity's coupon list with `byEntityCouponRecommendation`
 * (cguru-ui), which floats recommended offers to the top — but WordPress only
 * flags 8 posts as `popular_coupon`, so in practice every store page rendered a
 * flat, unranked list. Promoting the newest coupon per store gives every store
 * page a lead offer without an editor touching all 4,000+ of them.
 *
 * FILL-ONLY (`badge IS NULL`): never overwrites the `popular_coupon` badge from
 * phase 07, and never clobbers an editorially-chosen badge such as
 * "CG Exclusive" — this only fills the gap where there is no badge at all.
 *
 * Published coupons only: badging an expired offer would promote something the
 * public API filters out, leaving the store page's lead slot empty.
 *
 * Deterministic + idempotent: DISTINCT ON resolves ties by published date then
 * id, so a re-run picks the same coupon, finds it already badged, and updates
 * nothing. One coupon shared by several stores is simply badged once.
 */
async function markLatestStoreCouponsRecommended(): Promise<void> {
  const linkTable = "coupons_stores_lnk";
  const exists = await pgQuery<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1`,
    [linkTable]
  );
  if (exists.length === 0) {
    logger.warn(
      `${linkTable} not found — skipping the per-store "Recommended" badge pass.`
    );
    return;
  }

  const updated = await pgQuery<{ id: number }>(
    `UPDATE "coupons" c
        SET "badge" = 'Recommended'
      WHERE c."badge" IS NULL
        AND c."id" IN (
          SELECT DISTINCT ON (l."store_id") l."coupon_id"
            FROM "${linkTable}" l
            JOIN "coupons" c2 ON c2."id" = l."coupon_id"
           WHERE c2."content_status" = 'published'
           ORDER BY l."store_id",
                    c2."published_on" DESC NULLS LAST,
                    c2."published_at" DESC NULLS LAST,
                    c2."id" DESC
        )
      RETURNING c."id"`
  );

  logger.info(
    `Badged ${updated.length} coupon(s) as "Recommended" — the newest live coupon per store`
  );
}
