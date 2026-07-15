import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import pLimit from "p-limit";
import {
  setPostMapping,
  ensureTermMapping,
  getPoolMappingByName,
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
import { clean, cleanCode, cleanHtml } from "../utils/sanitize.js";
import { extractOfferText, extractCashbackFields } from "../utils/offer-extract.js";
import {
  normalizeWpDate,
  normalizeWpLocalDate,
  parseExpiryDate,
} from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";

interface WpPost {
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
}

interface PostMeta {
  [key: string]: string;
}

export async function runCoupons(): Promise<void> {
  logger.info("=== Phase 7: Coupons Migration ===");

  const posts = await wpQuery<WpPost>(`
    SELECT p.ID, p.post_title, p.post_name, p.post_content,
           CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
           CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END AS post_date_gmt,
           CASE WHEN CAST(p.post_modified AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified AS CHAR) END AS post_modified,
           CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END AS post_modified_gmt,
           p.post_status, p.post_author
    FROM wp_posts p
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
      AND p.ID NOT IN (
        SELECT post_id FROM wp_postmeta
        WHERE meta_key = 'is_deal' AND meta_value = 'yes'
      )
    ORDER BY p.ID
  `);

  logger.info(`Found ${posts.length} coupon posts`);
  if (posts.length === 0) return;

  // Saved migration maps can outlive a dev database reset. Never trust a
  // mapped Strapi admin ID until it is confirmed in the active target DB;
  // content authorship is optional, while a stale ID rejects the whole coupon.
  const adminUsers = await pgQuery<{ id: number }>(
    `SELECT "id" FROM "admin_users"`,
  );
  const validAdminUserIds = new Set(adminUsers.map((user) => user.id));

  const postIds = posts.map((p) => p.ID);

  // Bulk-fetch all data upfront
  const [allMeta, allRelations, primaryTerms] = await Promise.all([
    getPostMetaBulk(postIds),
    getTermRelationsBulk(postIds),
    getPrimaryTerms(postIds),
  ]);

  let inserted = 0;
  let failed = 0;
  const limit = pLimit(20);

  const tasks = posts.map((post) =>
    limit(async () => {
      const meta = allMeta.get(post.ID) || {};
      const relations = allRelations.get(post.ID) || [];
      const primaryTermId = primaryTerms.get(post.ID);

      try {
        const documentId = generateDocumentId(`coupon:${post.ID}`);
        const isUnique = meta.unique_coupon === "1" || meta.unique_coupon === "true";
        const uniqueCouponPoolName = clean(meta.unique_coupon_name);
        // Upload + rewrite images embedded in the post body so no content
        // image is left pointing at the old WordPress uploads URL.
        const contentMedia = await rewriteContentMedia(
          cleanHtml(stripShortcodes(post.post_content))
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
          `INSERT INTO "coupons" (
            "document_id", "title", "offer_text", "cashback_text", "bank_offer_text", "content",
            "code", "coupon_type", "badge",
            "affiliate_link", "expires_at", "scheduled_at", "content_status",
            "published_at", "created_at", "updated_at", "locale",
            "created_by_id", "updated_by_id"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
          )
          ON CONFLICT ("document_id") DO UPDATE SET
            "offer_text" = EXCLUDED."offer_text",
            "cashback_text" = EXCLUDED."cashback_text",
            "bank_offer_text" = EXCLUDED."bank_offer_text",
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
            isUnique ? "unique" : "static",
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
          result[0]?.id ?? (await getEntityIdByDocumentId("coupons", documentId));
        if (!entityId) {
          logger.warn(`Could not resolve entity id for coupon ${post.ID} (${post.post_title})`);
          return;
        }
        setPostMapping(post.ID, {
          id: entityId,
          documentId,
          type: "api::coupon.coupon",
          table: "coupons",
        });

        // Wire taxonomy relations
        await wireCouponRelations(entityId, relations, primaryTermId);

        // Link media (image) — on-demand upload
        const imageId = await resolveMediaRef(meta.image);
        if (imageId) {
          await linkMedia(imageId, entityId, "api::coupon.coupon", "image");
        }

        await linkContentMedia(
          contentMedia.fileIds,
          entityId,
          "api::coupon.coupon",
          "content"
        );

        // Link uniqueCouponPool if unique type
        if (isUnique && uniqueCouponPoolName) {
          const poolRef = getPoolMappingByName(uniqueCouponPoolName);
          if (poolRef) {
            await insertLink("coupons_unique_coupon_pool_lnk", {
              coupon_id: entityId,
              unique_coupon_pool_id: poolRef.id,
              coupon_ord: 1,
            });
          } else {
            logger.warn(
              `Unique coupon pool not found for coupon ${post.ID} (${post.post_title}): ${uniqueCouponPoolName}`
            );
          }
        } else if (isUnique) {
          logger.warn(
            `Unique coupon missing unique_coupon_name for coupon ${post.ID} (${post.post_title})`
          );
        }

        inserted++;
        if (inserted % 200 === 0) {
          logger.info(`  Processed ${inserted}/${posts.length} coupons`);
        }
      } catch (err: any) {
        failed++;
        logger.error(
          `Failed to insert coupon ${post.ID} (${post.post_title}): ${err.message}`
        );
      }
    })
  );

  await Promise.all(tasks);
  logger.info(`Coupons migration complete: ${inserted} inserted, ${failed} failed`);
}

async function wireCouponRelations(
  entityId: number,
  termIds: number[],
  primaryTermId: number | undefined
): Promise<void> {
  const orderByType = new Map<string, number>();

  if (primaryTermId) {
    const ref = await ensureTermMapping(primaryTermId);
    if (ref) {
      const linkTable = getLinkTable("coupons", ref.table);
      if (linkTable) {
        const ord = (orderByType.get(ref.table) || 0) + 1;
        orderByType.set(ref.table, ord);
        await insertLink(linkTable.table, {
          [linkTable.couponCol]: entityId,
          [linkTable.termCol]: ref.id,
          coupon_ord: ord,
        });
      }
    }
  }

  for (const termId of termIds) {
    if (termId === primaryTermId) continue;
    const ref = await ensureTermMapping(termId);
    if (!ref) continue;

    const linkTable = getLinkTable("coupons", ref.table);
    if (linkTable) {
      const ord = (orderByType.get(ref.table) || 0) + 1;
      orderByType.set(ref.table, ord);
      await insertLink(linkTable.table, {
        [linkTable.couponCol]: entityId,
        [linkTable.termCol]: ref.id,
        coupon_ord: ord,
      });
    }
  }
}

function getLinkTable(
  entityTable: string,
  termTable: string
): { table: string; couponCol: string; termCol: string } | null {
  const map: Record<string, { table: string; couponCol: string; termCol: string }> = {
    stores: {
      table: `${entityTable}_stores_lnk`,
      couponCol: `${entityTable.slice(0, -1)}_id`,
      termCol: "store_id",
    },
    brands: {
      table: `${entityTable}_brands_lnk`,
      couponCol: `${entityTable.slice(0, -1)}_id`,
      termCol: "brand_id",
    },
    categories: {
      table: `${entityTable}_categories_lnk`,
      couponCol: `${entityTable.slice(0, -1)}_id`,
      termCol: "category_id",
    },
    banks: {
      table: `${entityTable}_banks_lnk`,
      couponCol: `${entityTable.slice(0, -1)}_id`,
      termCol: "bank_id",
    },
  };
  return map[termTable] || null;
}

// ── Bulk data fetchers ──────────────────────────────────────────────

async function getPostMetaBulk(postIds: number[]): Promise<Map<number, PostMeta>> {
  if (postIds.length === 0) return new Map();
  const placeholders = postIds.map(() => "?").join(",");
  const rows = await wpQuery<{ post_id: number; meta_key: string; meta_value: string }>(`
    SELECT post_id, meta_key, meta_value
    FROM wp_postmeta
    WHERE post_id IN (${placeholders})
    AND meta_key IN (
      'code', 'link', 'popular_coupon', 'image',
      'is_deal', 'unique_coupon', 'unique_coupon_name',
      '_action_manager_date', '_expiration-date', '_expiration-date-status', 'expiration-date',
      '_edit_last'
    )
  `, postIds);

  const map = new Map<number, PostMeta>();
  for (const row of rows) {
    if (!map.has(row.post_id)) map.set(row.post_id, {});
    map.get(row.post_id)![row.meta_key] = row.meta_value;
  }
  return map;
}

async function getTermRelationsBulk(postIds: number[]): Promise<Map<number, number[]>> {
  if (postIds.length === 0) return new Map();
  const placeholders = postIds.map(() => "?").join(",");
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

async function getPrimaryTerms(postIds: number[]): Promise<Map<number, number>> {
  if (postIds.length === 0) return new Map();
  try {
    const placeholders = postIds.map(() => "?").join(",");
    const rows = await wpQuery<{ post_id: number; term_id: number }>(`
      SELECT post_id, term_id
      FROM wp_yoast_primary_term
      WHERE post_id IN (${placeholders})
      AND taxonomy = 'category'
    `, postIds);
    return new Map(rows.map((r) => [r.post_id, r.term_id]));
  } catch {
    logger.warn("wp_yoast_primary_term table not available");
    return new Map();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function getExpiryRaw(meta: PostMeta): string | undefined {
  if (meta["_action_manager_date"]) {
    return meta["_action_manager_date"];
  }

  if (meta["_expiration-date-status"] && meta["_expiration-date-status"] !== "saved") {
    return undefined;
  }

  return meta["_expiration-date"] || meta["expiration-date"];
}

function stripShortcodes(content: string): string {
  if (!content) return content;
  return content.replace(/\[\/?\w+[^\]]*\]/g, "").trim();
}
