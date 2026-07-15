import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import pLimit from "p-limit";
import {
  setPostMapping,
  ensureTermMapping,
  getUserMapping,
} from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import {
  generateDocumentId,
  getEntityIdByDocumentId,
  insertLink,
  linkMedia,
  linkContentMedia,
} from "../utils/strapi-insert.js";
import { computeMigrationStatus } from "../utils/content-status.js";
import { rewriteContentMedia } from "../utils/content-media.js";
import { clean, cleanCode } from "../utils/sanitize.js";
import { cleanDealContent } from "../utils/deal-content.js";
import { extractOfferText, extractCashbackFields } from "../utils/offer-extract.js";
import {
  normalizeWpDate,
  normalizeWpLocalDate,
  parseExpiryDate,
} from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";
import { parseDecimal } from "../utils/price.js";

export async function runDeals(): Promise<void> {
  logger.info("=== Phase 8: Deals Migration ===");

  const posts = await wpQuery<{
    ID: number;
    post_title: string;
    post_name: string;
    post_content: string;
    post_date: string | null;
    post_date_gmt: string | null;
    post_modified: string | null;
    post_modified_gmt: string | null;
    post_status: string;
    post_author: number;
  }>(`
    SELECT p.ID, p.post_title, p.post_name, p.post_content,
           CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
           CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END AS post_date_gmt,
           CASE WHEN CAST(p.post_modified AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified AS CHAR) END AS post_modified,
           CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END AS post_modified_gmt,
           p.post_status, p.post_author
    FROM wp_posts p
    JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
    ORDER BY p.ID
  `);

  logger.info(`Found ${posts.length} deal posts`);
  if (posts.length === 0) return;

  // Saved migration maps can outlive a dev database reset. Never trust a
  // mapped Strapi admin ID until it is confirmed in the active target DB;
  // content authorship is optional, while a stale ID rejects the whole deal.
  const adminUsers = await pgQuery<{ id: number }>(
    `SELECT "id" FROM "admin_users"`,
  );
  const validAdminUserIds = new Set(adminUsers.map((user) => user.id));

  const postIds = posts.map((p) => p.ID);
  const placeholders = postIds.map(() => "?").join(",");

  // Bulk-fetch all data upfront in parallel
  const [metaByPost, termRelByPost, primaryTerms] = await Promise.all([
    getMetaBulk(postIds, placeholders),
    getTermRelsBulk(postIds, placeholders),
    getPrimaryTerms(postIds, placeholders),
  ]);

  let inserted = 0;
  let failed = 0;
  const limit = pLimit(20);

  const tasks = posts.map((post) =>
    limit(async () => {
      const meta = metaByPost.get(post.ID) || {};
      const relations = termRelByPost.get(post.ID) || [];
      const primaryTermId = primaryTerms.get(post.ID);

      try {
        const documentId = generateDocumentId(`deal:${post.ID}`);
        // Upload + rewrite images embedded in the post body so no content
        // image is left pointing at the old WordPress uploads URL.
        const contentMedia = await rewriteContentMedia(
          post.post_content
            ? cleanDealContent(post.post_content.replace(/\[\/?\w+[^\]]*\]/g, ""))
            : null
        );
        const content = contentMedia.html;
        const title = clean(post.post_title) || post.post_title;
        // Best-effort badge + cashback/bank texts parsed from the title
        // (falling back to content); editors can correct these in the admin.
        const offerText = extractOfferText(title, content);
        const { cashbackText, bankOfferText } = extractCashbackFields(title, content);
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

        const mappedAuthorId = getUserMapping(post.post_author);
        const authorId =
          mappedAuthorId !== undefined && validAdminUserIds.has(mappedAuthorId)
            ? mappedAuthorId
            : null;
        // WP records the last editor in _edit_last; fall back to the author
        // when the editor was deleted from wp_users or never mapped.
        const mappedEditorId = meta._edit_last
          ? getUserMapping(parseInt(meta._edit_last, 10))
          : undefined;
        const editorId =
          mappedEditorId !== undefined && validAdminUserIds.has(mappedEditorId)
            ? mappedEditorId
            : authorId;

        const result = await pgQuery<{ id: number }>(
          `INSERT INTO "deals" (
            "document_id", "title", "offer_text", "cashback_text", "bank_offer_text", "content", "code",
            "sale_price", "mrp", "discount",
            "badge", "affiliate_link", "expires_at", "scheduled_at", "content_status",
            "published_at", "created_at", "updated_at", "locale",
            "created_by_id", "updated_by_id"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
          )
          ON CONFLICT ("document_id") DO UPDATE SET
            "offer_text" = EXCLUDED."offer_text",
            "cashback_text" = EXCLUDED."cashback_text",
            "bank_offer_text" = EXCLUDED."bank_offer_text",
            "sale_price" = EXCLUDED."sale_price",
            "mrp" = EXCLUDED."mrp",
            "discount" = EXCLUDED."discount",
            "content" = EXCLUDED."content"
          RETURNING id`,
          [
            documentId,
            title,
            offerText,
            cashbackText,
            bankOfferText,
            content,
            cleanCode(meta.code),
            salePrice,
            mrp,
            clean(meta.deal_discount),
            meta.popular_coupon === "1" ? "Recommended" : null,
            clean(meta.link),
            expiresAt,
            contentStatus.scheduledAt,
            contentStatus.contentStatus,
            contentStatus.publishedAt,
            createdAt,
            updatedAt,
            null,
            authorId,
            editorId,
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
        const linkedIdsByTable = new Map<string, Set<number>>();

        const linkTerm = async (termId: number): Promise<void> => {
          const ref = await ensureTermMapping(termId);
          if (!ref) return;
          const linkInfo = getDealLinkTable(ref.table);
          if (!linkInfo) return;
          let linked = linkedIdsByTable.get(linkInfo.table);
          if (!linked) {
            linked = new Set();
            linkedIdsByTable.set(linkInfo.table, linked);
          }
          if (linked.has(ref.id)) return;
          linked.add(ref.id);
          const ord = (orderByType.get(ref.table) || 0) + 1;
          orderByType.set(ref.table, ord);
          await insertLink(linkInfo.table, {
            [linkInfo.dealCol]: entityId,
            [linkInfo.termCol]: ref.id,
            deal_ord: ord,
          });
        };

        if (primaryTermId) {
          await linkTerm(primaryTermId);
        }

        for (const termId of relations) {
          if (termId === primaryTermId) continue;
          await linkTerm(termId);
        }

        // Merge deal_store meta into stores relation (dedup against taxonomy-linked stores)
        if (meta.deal_store) {
          const storeTermId = parseInt(meta.deal_store, 10);
          if (!isNaN(storeTermId)) {
            await linkTerm(storeTermId);
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

        await linkContentMedia(
          contentMedia.fileIds,
          entityId,
          "api::deal.deal",
          "content"
        );

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
      '_action_manager_date', '_expiration-date', '_expiration-date-status', 'expiration-date',
      '_edit_last'
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
