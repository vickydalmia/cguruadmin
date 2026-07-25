import { wpQuery } from "../db/wp-client.js";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import pLimit from "p-limit";
import {
  setPostMapping,
  getPoolMappingByName,
  getUserMapping,
} from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import {
  generateDocumentId,
  getEntityIdByDocumentId,
  replaceMedia,
  replaceContentMedia,
} from "../utils/strapi-insert.js";
import { replaceOfferTaxonomyRelations } from "../utils/offer-relations.js";
import {
  computeMigrationStatus,
  shouldImportMigrationOffer,
} from "../utils/content-status.js";
import { rewriteContentMedia } from "../utils/content-media.js";
import { clean, cleanCode, cleanHtml } from "../utils/sanitize.js";
import { extractOfferText, extractCashbackFields } from "../utils/offer-extract.js";
import {
  normalizeWpDate,
  normalizeWpLocalDate,
  parseExpiryDate,
} from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";
import { isAcfTrue } from "../utils/acf.js";
import { reconcileMigratedOfferInventory } from "../utils/offer-inventory.js";
import { getWpOfferExpiryRaw } from "../utils/wp-offer-expiry.js";
import { registerMigratedEntity } from "../utils/migration-registry.js";

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

  const sourcePosts = await wpQuery<WpPost>(`
    SELECT p.ID, p.post_title, p.post_name, p.post_content,
           CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
           CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END AS post_date_gmt,
           CASE WHEN CAST(p.post_modified AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified AS CHAR) END AS post_modified,
           CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END AS post_modified_gmt,
           p.post_status, p.post_author
    FROM wp_posts p
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future', 'draft', 'trash')
      AND NOT EXISTS (
        SELECT 1 FROM wp_postmeta
        WHERE post_id = p.ID
          AND meta_key = 'is_deal'
          AND meta_value = 'yes'
      )
    ORDER BY p.ID
  `);

  const sourcePostIds = sourcePosts.map((post) => post.ID);
  const allMeta = await getPostMetaBulk(sourcePostIds);
  const migrationNow = new Date();
  const posts = sourcePosts.filter((post) => {
    const expiresAt = parseExpiryDate(
      getWpOfferExpiryRaw(allMeta.get(post.ID) || {}),
    );
    return shouldImportMigrationOffer({
      postStatus: post.post_status,
      expiresAt,
      now: migrationNow,
    });
  });
  const expectedDocumentIds = new Set(
    posts.map((post) => generateDocumentId(`coupon:${post.ID}`)),
  );
  await reconcileMigratedOfferInventory("coupons", expectedDocumentIds);

  logger.info(
    `Found ${posts.length} importable coupon posts ` +
      `(${sourcePosts.length - posts.length} ordinary withdrawn posts excluded)`,
  );
  if (posts.length === 0) return;

  // Saved migration maps can outlive a dev database reset. Never trust a
  // mapped Strapi admin ID until it is confirmed in the active target DB;
  // content authorship is optional, while a stale ID rejects the whole coupon.
  const adminUsers = await pgQuery<{ id: number }>(
    `SELECT "id" FROM "admin_users"`,
  );
  const validAdminUserIds = new Set(adminUsers.map((user) => user.id));

  const postIds = posts.map((p) => p.ID);

  // Bulk-fetch relation data for importable posts only. Metadata was fetched
  // above because expiry determines whether a withdrawn draft/trash belongs.
  const [allRelations, primaryTerms] = await Promise.all([
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
        const sourceKey = `coupon:${post.ID}`;
        const documentId = generateDocumentId(sourceKey);
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
        const affiliateLink = clean(meta.link);
        const missingRequired = [
          !title.trim() ? "title" : null,
          !offerText?.trim() ? "offerText" : null,
          !content?.trim() ? "content" : null,
          !affiliateLink?.trim() ? "affiliateLink" : null,
        ].filter(Boolean);
        if (missingRequired.length > 0) {
          logger.warn(
            `Coupon ${post.ID} (${post.post_title}) has required field gap(s): ${missingRequired.join(", ")}. Importing it so the record can be corrected editorially.`,
          );
        }
        const createdAt =
          normalizeWpDate(post.post_date_gmt) ||
          normalizeWpLocalDate(post.post_date) ||
          new Date().toISOString();
        const updatedAt =
          normalizeWpDate(post.post_modified_gmt) ||
          normalizeWpLocalDate(post.post_modified) ||
          createdAt;

        const expiryRaw = getWpOfferExpiryRaw(meta);
        const expiresAt = parseExpiryDate(expiryRaw);

        const contentStatus = computeMigrationStatus({
          postDate: createdAt,
          postStatus: post.post_status,
          expiresAt,
          now: migrationNow,
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

        // `published_on` is the EDITOR-CONTROLLED "newest first" sort key
        // (src/utils/offer-visibility.ts) and is seeded here from published_at.
        // It MUST be written at insert time: Postgres orders NULLs FIRST in a
        // DESC sort, so a row with no published_on outranks every row an editor
        // has actually dated — "Bump to top" would push an offer to the BOTTOM.
        // The bug hides while the column is uniformly NULL (everything ties and
        // falls through to the published_at tiebreaker) and only surfaces on the
        // first bump, so it must not be left to a backfill.
        const result = await pgQuery<{ id: number }>(
          `INSERT INTO "coupons" (
            "document_id", "title", "offer_text", "cashback_text", "bank_offer_text", "content",
            "code", "coupon_type", "badge",
            "affiliate_link", "expires_at", "scheduled_at", "content_status",
            "published_at", "published_on", "created_at", "updated_at", "locale",
            "created_by_id", "updated_by_id"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
          )
          ON CONFLICT ("document_id") DO UPDATE SET
            "title" = EXCLUDED."title",
            "offer_text" = EXCLUDED."offer_text",
            "cashback_text" = EXCLUDED."cashback_text",
            "bank_offer_text" = EXCLUDED."bank_offer_text",
            "content" = EXCLUDED."content",
            "code" = EXCLUDED."code",
            "coupon_type" = EXCLUDED."coupon_type",
            "badge" = COALESCE(EXCLUDED."badge", "coupons"."badge"),
            "affiliate_link" = EXCLUDED."affiliate_link",
            "expires_at" = EXCLUDED."expires_at",
            "scheduled_at" = EXCLUDED."scheduled_at",
            "content_status" = EXCLUDED."content_status",
            "published_at" = EXCLUDED."published_at",
            "published_on" = COALESCE("coupons"."published_on", EXCLUDED."published_on"),
            "updated_at" = EXCLUDED."updated_at",
            "updated_by_id" = EXCLUDED."updated_by_id"
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
            isAcfTrue(meta.popular_coupon) ? "Recommended" : null,
            affiliateLink,
            expiresAt,
            contentStatus.scheduledAt,
            contentStatus.contentStatus,
            contentStatus.publishedAt,
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
        await registerMigratedEntity({
          documentId,
          sourceKey,
          targetTable: "coupons",
        });

        // Wire taxonomy relations
        await replaceOfferTaxonomyRelations("coupons", entityId, {
          termIds: relations,
          primaryTermId,
        });

        // Replace field media so a changed/cleared WP image cannot leave a
        // stale active relation on an in-place re-import.
        const imageId = await resolveMediaRef(meta.image);
        await replaceMedia(
          imageId ?? null,
          entityId,
          "api::coupon.coupon",
          "image",
        );

        await replaceContentMedia(
          contentMedia.fileIds,
          entityId,
          "api::coupon.coupon",
          "content"
        );

        // This relation is source-owned too: switching pools or changing a
        // Coupon back to static must remove the previous link.
        const poolRef =
          isUnique && uniqueCouponPoolName
            ? getPoolMappingByName(uniqueCouponPoolName)
            : undefined;
        await pgTransaction(async () => {
          await pgQuery(
            `DELETE FROM "coupons_unique_coupon_pool_lnk"
             WHERE "coupon_id" = $1`,
            [entityId],
          );
          if (poolRef) {
            await pgQuery(
              `INSERT INTO "coupons_unique_coupon_pool_lnk"
                 ("coupon_id", "unique_coupon_pool_id", "coupon_ord")
               VALUES ($1, $2, 1)`,
              [entityId, poolRef.id],
            );
          }
        });
        if (isUnique && uniqueCouponPoolName && !poolRef) {
          logger.warn(
            `Unique coupon pool not found for coupon ${post.ID} (${post.post_title}): ${uniqueCouponPoolName}`
          );
        } else if (isUnique && !uniqueCouponPoolName) {
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
  if (failed > 0) {
    throw new Error(
      `${failed} Coupon(s) failed import; see the WordPress post IDs above`,
    );
  }
}

// ── Bulk data fetchers ──────────────────────────────────────────────

async function getPostMetaBulk(postIds: number[]): Promise<Map<number, PostMeta>> {
  const map = new Map<number, PostMeta>();
  const batchSize = 5_000;
  for (let start = 0; start < postIds.length; start += batchSize) {
    const ids = postIds.slice(start, start + batchSize);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await wpQuery<{
      post_id: number;
      meta_key: string;
      meta_value: string;
    }>(
      `SELECT post_id, meta_key, meta_value
       FROM wp_postmeta
       WHERE post_id IN (${placeholders})
       AND meta_key IN (
         'code', 'link', 'popular_coupon', 'image',
         'is_deal', 'unique_coupon', 'unique_coupon_name',
         '_action_manager_date', '_expiration-date', '_expiration-date-status', 'expiration-date',
         '_edit_last'
       )`,
      ids,
    );
    for (const row of rows) {
      if (!map.has(row.post_id)) map.set(row.post_id, {});
      map.get(row.post_id)![row.meta_key] = row.meta_value;
    }
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
    ORDER BY tr.object_id, tr.term_order, tt.term_id
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

function stripShortcodes(content: string): string {
  if (!content) return content;
  return content.replace(/\[\/?\w+[^\]]*\]/g, "").trim();
}
