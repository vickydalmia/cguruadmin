import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import pLimit from "p-limit";
import {
  setPostMapping,
  ensureTermMapping,
  getTagMapping,
} from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import {
  generateDocumentId,
  getEntityIdByDocumentId,
  insertLink,
  linkMedia,
} from "../utils/strapi-insert.js";
import { computeMigrationStatus } from "../utils/content-status.js";
import { clean, cleanSlug } from "../utils/sanitize.js";
import {
  normalizeWpDate,
  normalizeWpLocalDate,
  parseExpiryDate,
} from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";

export async function runDeals(): Promise<void> {
  logger.info("=== Phase 8: Deals Migration ===");

  const posts = await wpQuery<{
    ID: number;
    post_title: string;
    post_name: string;
    post_content: string;
    post_excerpt: string;
    post_date: string | null;
    post_date_gmt: string | null;
    post_modified: string | null;
    post_modified_gmt: string | null;
    post_status: string;
  }>(`
    SELECT p.ID, p.post_title, p.post_name, p.post_content, p.post_excerpt,
           CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
           CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END AS post_date_gmt,
           CASE WHEN CAST(p.post_modified AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified AS CHAR) END AS post_modified,
           CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END AS post_modified_gmt,
           p.post_status
    FROM wp_posts p
    JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
    ORDER BY p.ID
  `);

  logger.info(`Found ${posts.length} deal posts`);
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.ID);
  const placeholders = postIds.map(() => "?").join(",");

  // Bulk-fetch all data upfront in parallel
  const [metaByPost, termRelByPost, primaryTerms, tagRelByPost] = await Promise.all([
    getMetaBulk(postIds, placeholders),
    getTermRelsBulk(postIds, placeholders),
    getPrimaryTerms(postIds, placeholders),
    getTagRelsBulk(postIds, placeholders),
  ]);

  let inserted = 0;
  let failed = 0;
  const limit = pLimit(20);

  const tasks = posts.map((post) =>
    limit(async () => {
      const meta = metaByPost.get(post.ID) || {};
      const relations = termRelByPost.get(post.ID) || [];
      const primaryTermId = primaryTerms.get(post.ID);
      const tagIds = tagRelByPost.get(post.ID) || [];

      try {
        const documentId = generateDocumentId(`deal:${post.ID}`);
        const content = post.post_content
          ? clean(post.post_content.replace(/\[\/?\w+[^\]]*\]/g, ""))
          : null;
        const createdAt =
          normalizeWpDate(post.post_date_gmt) ||
          normalizeWpLocalDate(post.post_date) ||
          new Date().toISOString();
        const updatedAt =
          normalizeWpDate(post.post_modified_gmt) ||
          normalizeWpLocalDate(post.post_modified) ||
          createdAt;

        const salePrice = parseDecimal(meta.deal_sale_price);
        const mrp = parseDecimal(meta.deal_mrp);

        const expiryRaw = getExpiryRaw(meta);
        const expiresAt = parseExpiryDate(expiryRaw);

        const contentStatus = computeMigrationStatus({
          postDate: createdAt,
          postStatus: post.post_status,
          expiresAt,
        });

        const result = await pgQuery<{ id: number }>(
          `INSERT INTO "deals" (
            "document_id", "title", "content", "excerpt",
            "sale_price", "mrp", "discount",
            "is_popular", "affiliate_link", "expires_at", "scheduled_at", "content_status",
            "published_at", "created_at", "updated_at", "locale"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
          )
          ON CONFLICT ("document_id") DO NOTHING
          RETURNING id`,
          [
            documentId,
            clean(post.post_title) || post.post_title,
            content,
            clean(post.post_excerpt),
            salePrice,
            mrp,
            clean(meta.deal_discount),
            meta.popular_coupon === "1",
            clean(meta.link),
            expiresAt,
            contentStatus.scheduledAt,
            contentStatus.contentStatus,
            contentStatus.publishedAt,
            createdAt,
            updatedAt,
            null,
          ]
        );

        const entityId =
          result[0]?.id ?? (await getEntityIdByDocumentId("deals", documentId));
        if (!entityId) {
          logger.warn(`Could not resolve entity id for deal ${post.ID} (${post.post_title})`);
          return;
        }
        setPostMapping(post.ID, {
          id: entityId,
          documentId,
          type: "api::deal.deal",
          table: "deals",
        });

        // Wire taxonomy relations
        const orderByType = new Map<string, number>();

        if (primaryTermId) {
          const ref = await ensureTermMapping(primaryTermId);
          if (ref) {
            const linkInfo = getDealLinkTable(ref.table);
            if (linkInfo) {
              const ord = (orderByType.get(ref.table) || 0) + 1;
              orderByType.set(ref.table, ord);
              await insertLink(linkInfo.table, {
                [linkInfo.dealCol]: entityId,
                [linkInfo.termCol]: ref.id,
                deal_ord: ord,
              });
            }
          }
        }

        for (const termId of relations) {
          if (termId === primaryTermId) continue;
          const ref = await ensureTermMapping(termId);
          if (!ref) continue;
          const linkInfo = getDealLinkTable(ref.table);
          if (linkInfo) {
            const ord = (orderByType.get(ref.table) || 0) + 1;
            orderByType.set(ref.table, ord);
            await insertLink(linkInfo.table, {
              [linkInfo.dealCol]: entityId,
              [linkInfo.termCol]: ref.id,
              deal_ord: ord,
            });
          }
        }

        // Wire displayStore
        if (meta.deal_store) {
          const storeTermId = parseInt(meta.deal_store, 10);
          if (!isNaN(storeTermId)) {
            const storeRef = await ensureTermMapping(storeTermId);
            if (storeRef && storeRef.table === "stores") {
              await insertLink("deals_display_store_lnk", {
                deal_id: entityId,
                store_id: storeRef.id,
              });
            }
          }
        }

        // Wire tag relations (pre-fetched)
        for (const wpTagTermId of tagIds) {
          const tagRef = getTagMapping(wpTagTermId);
          if (tagRef) {
            await insertLink("deals_tags_lnk", {
              deal_id: entityId,
              tag_id: tagRef.id,
              tag_ord: 1,
              deal_ord: 1,
            });
          }
        }

        // Link dealImage — on-demand upload
        const dealImageId = await resolveMediaRef(meta.deal_image);
        if (dealImageId) {
          await linkMedia(dealImageId, entityId, "api::deal.deal", "dealImage");
        } else {
          const imageId = await resolveMediaRef(meta.image);
          if (imageId) {
            await linkMedia(imageId, entityId, "api::deal.deal", "dealImage");
          }
        }

        inserted++;
        if (inserted % 200 === 0) {
          logger.info(`  Processed ${inserted}/${posts.length} deals`);
        }
      } catch (err: any) {
        failed++;
        logger.error(
          `Failed to insert deal ${post.ID} (${post.post_title}): ${err.message}`
        );
      }
    })
  );

  await Promise.all(tasks);
  logger.info(`Deals migration complete: ${inserted} inserted, ${failed} failed`);
}

// ── Bulk data fetchers ──────────────────────────────────────────────

async function getMetaBulk(
  postIds: number[],
  placeholders: string
): Promise<Map<number, Record<string, string>>> {
  const rows = await wpQuery<{ post_id: number; meta_key: string; meta_value: string }>(`
    SELECT post_id, meta_key, meta_value
    FROM wp_postmeta
    WHERE post_id IN (${placeholders})
    AND meta_key IN (
      'code', 'link', 'popular_coupon', 'image',
      'deal_mrp', 'deal_sale_price', 'deal_discount', 'deal_image', 'deal_store',
      '_action_manager_date', '_expiration-date', '_expiration-date-status', 'expiration-date'
    )
  `, postIds);

  const map = new Map<number, Record<string, string>>();
  for (const row of rows) {
    if (!map.has(row.post_id)) map.set(row.post_id, {});
    map.get(row.post_id)![row.meta_key] = row.meta_value;
  }
  return map;
}

async function getTermRelsBulk(
  postIds: number[],
  placeholders: string
): Promise<Map<number, number[]>> {
  const rows = await wpQuery<{ object_id: number; term_id: number }>(`
    SELECT tr.object_id, tt.term_id
    FROM wp_term_relationships tr
    JOIN wp_term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'category'
    WHERE tr.object_id IN (${placeholders})
  `, postIds);

  const map = new Map<number, number[]>();
  for (const row of rows) {
    if (!map.has(row.object_id)) map.set(row.object_id, []);
    map.get(row.object_id)!.push(row.term_id);
  }
  return map;
}

async function getPrimaryTerms(
  postIds: number[],
  placeholders: string
): Promise<Map<number, number>> {
  try {
    const rows = await wpQuery<{ post_id: number; term_id: number }>(`
      SELECT post_id, term_id
      FROM wp_yoast_primary_term
      WHERE post_id IN (${placeholders}) AND taxonomy = 'category'
    `, postIds);
    return new Map(rows.map((r) => [r.post_id, r.term_id]));
  } catch {
    logger.warn("wp_yoast_primary_term not available for deals");
    return new Map();
  }
}

async function getTagRelsBulk(
  postIds: number[],
  placeholders: string
): Promise<Map<number, number[]>> {
  const rows = await wpQuery<{ object_id: number; term_id: number }>(`
    SELECT tr.object_id, tt.term_id
    FROM wp_term_relationships tr
    JOIN wp_term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'post_tag'
    WHERE tr.object_id IN (${placeholders})
  `, postIds);

  const map = new Map<number, number[]>();
  for (const row of rows) {
    if (!map.has(row.object_id)) map.set(row.object_id, []);
    map.get(row.object_id)!.push(row.term_id);
  }
  return map;
}

// ── Helpers ──────────────────────────────────────────────────────────

function getExpiryRaw(meta: Record<string, string>): string | undefined {
  if (meta["_action_manager_date"]) {
    return meta["_action_manager_date"];
  }

  if (meta["_expiration-date-status"] && meta["_expiration-date-status"] !== "saved") {
    return undefined;
  }

  return meta["_expiration-date"] || meta["expiration-date"];
}

function getDealLinkTable(
  termTable: string
): { table: string; dealCol: string; termCol: string } | null {
  const map: Record<string, { table: string; dealCol: string; termCol: string }> = {
    stores: { table: "deals_stores_lnk", dealCol: "deal_id", termCol: "store_id" },
    brands: { table: "deals_brands_lnk", dealCol: "deal_id", termCol: "brand_id" },
    categories: { table: "deals_categories_lnk", dealCol: "deal_id", termCol: "category_id" },
    banks: { table: "deals_banks_lnk", dealCol: "deal_id", termCol: "bank_id" },
  };
  return map[termTable] || null;
}

function parseDecimal(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}
