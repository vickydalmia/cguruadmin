import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import pLimit from "p-limit";
import {
  setPostMapping,
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
import { clean, cleanCode } from "../utils/sanitize.js";
import { cleanDealContent } from "../utils/deal-content.js";
import { extractOfferText, extractCashbackFields } from "../utils/offer-extract.js";
import {
  normalizeWpDate,
  normalizeWpLocalDate,
  parseExpiryDate,
} from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";
import { isAcfTrue, parseAcfTermId } from "../utils/acf.js";
import { parseDecimal } from "../utils/price.js";
import { reconcileMigratedOfferInventory } from "../utils/offer-inventory.js";
import { getWpOfferExpiryRaw } from "../utils/wp-offer-expiry.js";
import { registerMigratedEntity } from "../utils/migration-registry.js";

export async function runDeals(): Promise<void> {
  logger.info("=== Phase 8: Deals Migration ===");

  const sourcePosts = await wpQuery<{
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
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future', 'draft', 'trash')
      AND EXISTS (
        SELECT 1 FROM wp_postmeta
        WHERE post_id = p.ID
          AND meta_key = 'is_deal'
          AND meta_value = 'yes'
      )
    ORDER BY p.ID
  `);

  const sourcePostIds = sourcePosts.map((post) => post.ID);
  const metaByPost = await getMetaBulk(sourcePostIds);
  const migrationNow = new Date();
  const posts = sourcePosts.filter((post) => {
    const expiresAt = parseExpiryDate(
      getWpOfferExpiryRaw(metaByPost.get(post.ID) || {}),
    );
    return shouldImportMigrationOffer({
      postStatus: post.post_status,
      expiresAt,
      now: migrationNow,
    });
  });
  const expectedDocumentIds = new Set(
    posts.map((post) => generateDocumentId(`deal:${post.ID}`)),
  );
  await reconcileMigratedOfferInventory("deals", expectedDocumentIds);

  logger.info(
    `Found ${posts.length} importable deal posts ` +
      `(${sourcePosts.length - posts.length} ordinary withdrawn posts excluded)`,
  );
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

  // Bulk-fetch relation data for importable posts only. Metadata was fetched
  // above because expiry determines whether a withdrawn draft/trash belongs.
  const [termRelByPost, primaryTerms] = await Promise.all([
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
        const sourceKey = `deal:${post.ID}`;
        const documentId = generateDocumentId(sourceKey);
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
        const affiliateLink = clean(meta.link);
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
        const dealImageId = await resolveMediaRef(meta.deal_image);
        const fallbackImageId = dealImageId
          ? null
          : await resolveMediaRef(meta.image);
        const importedDealImageId = dealImageId ?? fallbackImageId ?? null;
        const missingRequired = [
          !title.trim() ? "title" : null,
          !offerText?.trim() ? "offerText" : null,
          !content?.trim() ? "content" : null,
          !affiliateLink?.trim() ? "affiliateLink" : null,
          salePrice === null ? "salePrice" : null,
          mrp === null ? "mrp" : null,
          importedDealImageId === null ? "dealImage" : null,
        ].filter(Boolean);
        if (missingRequired.length > 0) {
          logger.warn(
            `Deal ${post.ID} (${post.post_title}) has required field gap(s): ${missingRequired.join(", ")}. Importing it so the record can be corrected editorially.`,
          );
        }

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
          `INSERT INTO "deals" (
            "document_id", "title", "offer_text", "cashback_text", "bank_offer_text", "content", "code",
            "sale_price", "mrp", "discount",
            "badge", "affiliate_link", "expires_at", "scheduled_at", "content_status",
            "published_at", "published_on", "created_at", "updated_at", "locale",
            "created_by_id", "updated_by_id"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
          )
          ON CONFLICT ("document_id") DO UPDATE SET
            "title" = EXCLUDED."title",
            "offer_text" = EXCLUDED."offer_text",
            "cashback_text" = EXCLUDED."cashback_text",
            "bank_offer_text" = EXCLUDED."bank_offer_text",
            "code" = EXCLUDED."code",
            "sale_price" = EXCLUDED."sale_price",
            "mrp" = EXCLUDED."mrp",
            "discount" = EXCLUDED."discount",
            "content" = EXCLUDED."content",
            "badge" = COALESCE(EXCLUDED."badge", "deals"."badge"),
            "affiliate_link" = EXCLUDED."affiliate_link",
            "expires_at" = EXCLUDED."expires_at",
            "scheduled_at" = EXCLUDED."scheduled_at",
            "content_status" = EXCLUDED."content_status",
            "published_at" = EXCLUDED."published_at",
            "published_on" = COALESCE("deals"."published_on", EXCLUDED."published_on"),
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
            salePrice,
            mrp,
            clean(meta.deal_discount),
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
        await registerMigratedEntity({
          documentId,
          sourceKey,
          targetTable: "deals",
        });

        // The ACF `deal_store` is linked FIRST so it lands at deal_ord 1 and
        // becomes `stores[0]`. This used to be a dedicated `deal.primaryStore`
        // relation; with that field removed, the site resolves a deal's owning
        // store as `stores[0]` (see primaryEntity() in cguru-ui), so the
        // ordering IS the primary-store signal. Linked last — as it was — the
        // ACF store ended up at the tail and a different store won the card
        // badge. `parseAcfTermId` replaces a bare parseInt that returned NaN
        // for every PHP-serialized value and dropped those stores silently.
        const dealStoreTermId = parseAcfTermId(meta.deal_store);
        await replaceOfferTaxonomyRelations("deals", entityId, {
          termIds: relations,
          primaryTermId,
          acfStoreTermId: dealStoreTermId,
        });

        // Replace dealImage exactly so a source change or clear cannot leave a
        // stale product image active after an in-place re-import.
        await replaceMedia(
          importedDealImageId,
          entityId,
          "api::deal.deal",
          "dealImage",
        );

        await replaceContentMedia(
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
  if (failed > 0) {
    throw new Error(
      `${failed} Deal(s) failed import; see the WordPress post IDs above`,
    );
  }
}

// ── Bulk data fetchers ──────────────────────────────────────────────

async function getMetaBulk(
  postIds: number[],
): Promise<Map<number, Record<string, string>>> {
  const map = new Map<number, Record<string, string>>();
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
         'deal_mrp', 'deal_sale_price', 'deal_discount', 'deal_image', 'deal_store',
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

async function getTermRelsBulk(
  postIds: number[],
  placeholders: string
): Promise<Map<number, number[]>> {
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
