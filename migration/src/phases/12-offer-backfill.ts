import pLimit from "p-limit";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { ensurePostMapping } from "../utils/id-maps.js";
import { replaceOfferTaxonomyRelations } from "../utils/offer-relations.js";
import { logger } from "../utils/logger.js";
import { parseAcfTermId } from "../utils/acf.js";
import {
  getImportExclusions,
  hasExcludedTerm,
} from "../utils/import-exclusions.js";
import {
  allowsPartialDeals,
  type PhaseOutcome,
} from "../utils/phase-outcome.js";
import { hasStaleEmptyDealTarget } from "../utils/target-continuity.js";

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
 * cleared: stale links disappear and ACF store → actual WP taxonomy terms
 * converges to the same state as a clean phase-08 import.
 */
export async function runOfferBackfill(): Promise<void | PhaseOutcome> {
  logger.info("=== Phase 12: Offer Backfill (ACF deal_store → stores taxonomy) ===");
  const allowPartial = allowsPartialDeals();

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

  // Posts under an excluded term (Articles tree, retired stores) were never
  // imported — no mapping exists for them BY DESIGN, so they must not count
  // as reconciliation failures. Mirrors phases 07/08/10.
  const exclusions = await getImportExclusions();
  const importableRows = rows.filter(
    (row) =>
      !hasExcludedTerm(relationsByPost.get(row.post_id) ?? [], exclusions.termIds),
  );
  if (importableRows.length !== rows.length) {
    logger.info(
      `Skipping ${rows.length - importableRows.length} excluded deal post(s) ` +
      `(articles/retired stores) — never imported, nothing to reconcile`,
    );
  }

  // Guard against stale ID maps only when this source actually has Deals to
  // reconcile. A Coupons-only profile such as USA legitimately has an empty
  // source inventory and target `deals` table; no Deal mapping is read in that
  // case, and the Coupon recommendation backfill below must still run.
  const [{ count: dealCount }] = await pgQuery<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM deals",
  );
  if (hasStaleEmptyDealTarget(importableRows.length, Number(dealCount))) {
    throw new Error(
      "Strapi `deals` table is empty even though importable WordPress Deals exist; " +
        "check that Phase 08 ran against this target database. If the migration state " +
        "belongs to another database, run a full clean migration: yarn migrate --clean",
    );
  }

  let reconciled = 0;
  let skipped = 0;
  const limit = pLimit(20);
  await Promise.all(
    importableRows.map((row) =>
      limit(async () => {
        try {
          const ref = await ensurePostMapping(row.post_id, "deals");
          if (!ref) {
            skipped++;
            return;
          }
          const dealStoreTermId = parseAcfTermId(row.deal_store);
          await replaceOfferTaxonomyRelations("deals", ref.id, {
            termIds: relationsByPost.get(row.post_id) ?? [],
            logoStoreTermIds: dealStoreTermId ? [dealStoreTermId] : [],
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
  if (skipped > 0 && !allowPartial) {
    throw new Error(
      `${skipped} Deal taxonomy set(s) failed reconciliation; see the WordPress post IDs above`,
    );
  }

  await markLatestStoreCouponsRecommended();

  if (skipped > 0) {
    logger.warn(
      `Continuing after ${skipped} Deal taxonomy reconciliation failure(s) because ` +
        `--allow-partial-deals was provided. Phase 12 will not be checkpointed, ` +
        `so these Deals are retried on the next run.`,
    );
    return { checkpoint: false };
  }
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
