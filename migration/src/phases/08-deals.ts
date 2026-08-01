import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import pLimit from "p-limit";
import {
  setPostMapping,
  getUserMapping,
} from "../utils/id-maps.js";
import { resolveDealMediaRef } from "../utils/media-resolver.js";
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
import { extractCashbackFields } from "../utils/offer-extract.js";
import {
  normalizeWpDate,
  normalizeWpLocalDate,
  parseExpiryDate,
} from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";
import { isAcfTrue, parseAcfTermId } from "../utils/acf.js";
import { parseDecimal } from "../utils/price.js";
import { reconcileMigratedOfferInventory } from "../utils/offer-inventory.js";
import {
  getImportExclusions,
  hasExcludedTerm,
} from "../utils/import-exclusions.js";
import { getWpOfferExpiryRaw } from "../utils/wp-offer-expiry.js";
import { registerMigratedEntity } from "../utils/migration-registry.js";
import {
  allowsPartialDeals,
  type PhaseOutcome,
} from "../utils/phase-outcome.js";
// The application owns the discount parser; imported dynamically because
// cguruadmin is CommonJS while this package runs as ESM under tsx — a static
// named import from the CJS scope loses its exports (visible on Node 24).
// Same pattern as calculateImageBackgroundColour in 02-media-upload.ts.
const { parseLegacyDealDiscount } = await import(
  "../../../src/utils/deal-discount.js"
);

export async function runDeals(): Promise<void | PhaseOutcome> {
  logger.info("=== Phase 8: Deals Migration ===");
  const allowPartial = allowsPartialDeals();

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
      AND p.post_status IN ('publish', 'future')
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
  const lifecyclePosts = sourcePosts.filter((post) => {
    const expiresAt = parseExpiryDate(
      getWpOfferExpiryRaw(metaByPost.get(post.ID) || {}),
    );
    return shouldImportMigrationOffer({
      postStatus: post.post_status,
      expiresAt,
      now: migrationNow,
    });
  });

  // Posts filed under an excluded term (Articles tree, retired stores)
  // are not deals to import. Excluding them BEFORE expectedDocumentIds means the inventory
  // reconciliation also converges previously imported excluded posts away on
  // a re-import, instead of keeping them alive.
  const lifecyclePostIds = lifecyclePosts.map((post) => post.ID);
  const [exclusions, termRelByPost] = await Promise.all([
    getImportExclusions(),
    getTermRelsBulk(
      lifecyclePostIds,
      lifecyclePostIds.map(() => "?").join(","),
    ),
  ]);
  const excludedPosts = lifecyclePosts.filter((post) =>
    hasExcludedTerm(termRelByPost.get(post.ID) ?? [], exclusions.termIds),
  );
  if (excludedPosts.length > 0) {
    const sample = excludedPosts
      .slice(0, 10)
      .map((post) => `${post.ID} (${post.post_title})`);
    logger.info(
      `Skipping ${excludedPosts.length} excluded post(s) (articles/retired ` +
        `stores): ${sample.join("; ")}` +
        (excludedPosts.length > sample.length ? "; ..." : ""),
    );
  }
  const excludedPostIds = new Set(excludedPosts.map((post) => post.ID));
  const posts = lifecyclePosts.filter((post) => !excludedPostIds.has(post.ID));

  const expectedDocumentIds = new Set(
    posts.map((post) => generateDocumentId(`deal:${post.ID}`)),
  );
  await reconcileMigratedOfferInventory("deals", expectedDocumentIds);

  logger.info(
    `Found ${posts.length} importable deal posts ` +
      `(${sourcePosts.length - lifecyclePosts.length} non-importable post(s) ` +
      `dropped, ${excludedPosts.length} excluded post(s))`,
  );
  if (posts.length === 0) return;

  // Saved migration maps can outlive a dev database reset. Never trust a
  // mapped Strapi admin ID until it is confirmed in the active target DB;
  // content authorship is optional, while a stale ID rejects the whole deal.
  const adminUsers = await pgQuery<{ id: number }>(
    `SELECT "id" FROM "admin_users"`,
  );
  const validAdminUserIds = new Set(adminUsers.map((user) => user.id));

  let inserted = 0;
  let failed = 0;
  let dealImagesFinished = 0;
  let dealImagesReady = 0;
  let dealImagesMissing = 0;
  let dealImagesFailed = 0;
  const limit = pLimit(20);

  const tasks = posts.map((post, postIndex) =>
    limit(async () => {
      const meta = metaByPost.get(post.ID) || {};
      const relations = termRelByPost.get(post.ID) || [];
      let dealImageStatus: "ready" | "missing" | "failed" = "failed";

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
        // Best-effort cashback/bank/prepaid texts parsed from the title
        // (falling back to content); editors can correct these in the admin.
        const { cashbackText, bankOfferText, prepaidText } = extractCashbackFields(title, content);
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
        const legacyDiscount = clean(meta.deal_discount);
        const standardizedDiscount = parseLegacyDealDiscount(legacyDiscount);
        const discount = standardizedDiscount?.discount ?? legacyDiscount;
        const discountPrefix = standardizedDiscount?.discountPrefix ?? null;
        logger.info(
          `[deal-image ${postIndex + 1}/${posts.length}] resolving WordPress ` +
            `Deal ${post.ID} (${post.post_title})`,
        );
        const dealImageId = await resolveDealMediaRef(meta.deal_image);
        const fallbackImageId = dealImageId
          ? null
          : await resolveDealMediaRef(meta.image);
        const importedDealImageId = dealImageId ?? fallbackImageId ?? null;
        dealImageStatus = importedDealImageId ? "ready" : "missing";
        logger.info(
          `[deal-image ${postIndex + 1}/${posts.length}] WordPress Deal ` +
            `${post.ID} ${importedDealImageId ? `uses file_id=${importedDealImageId}` : "has no resolvable image"}`,
        );
        // `content` is not listed: Deal content is optional — the public API
        // sends a pre-calculated price/MRP/discount block, and written content
        // is only the extra "Any Other Condition" section.
        const missingRequired = [
          !title.trim() ? "title" : null,
          !affiliateLink?.trim() ? "affiliateLink" : null,
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

        // `published_on` is the EDITOR-CONTROLLED relevance/"newest first"
        // sort key (src/utils/offer-visibility.ts). Seeded from the WordPress
        // PUBLISH date (post_date via createdAt) so the imported ordering
        // matches the old site exactly; editors bump offers by re-dating
        // them after migration.
        // It MUST be written at insert time: Postgres orders NULLs FIRST in a
        // DESC sort, so a row with no published_on outranks every row an editor
        // has actually dated — "Bump to top" would push an offer to the BOTTOM.
        // The bug hides while the column is uniformly NULL (everything ties and
        // falls through to the published_at tiebreaker) and only surfaces on the
        // first bump, so it must not be left to a backfill.
        const result = await pgQuery<{ id: number }>(
          `INSERT INTO "deals" (
            "document_id", "title", "cashback_text", "bank_offer_text", "prepaid_text", "content", "code",
            "coupon_type",
            "sale_price", "mrp", "discount", "discount_prefix",
            "badge", "affiliate_link", "expires_at", "scheduled_at", "content_status",
            "published_at", "published_on", "created_at", "updated_at", "locale",
            "created_by_id", "updated_by_id"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
          )
          ON CONFLICT ("document_id") DO UPDATE SET
            "title" = EXCLUDED."title",
            "cashback_text" = EXCLUDED."cashback_text",
            "bank_offer_text" = EXCLUDED."bank_offer_text",
            "prepaid_text" = EXCLUDED."prepaid_text",
            "code" = EXCLUDED."code",
            "coupon_type" = COALESCE("deals"."coupon_type", EXCLUDED."coupon_type"),
            "sale_price" = EXCLUDED."sale_price",
            "mrp" = EXCLUDED."mrp",
            "discount" = EXCLUDED."discount",
            "discount_prefix" = EXCLUDED."discount_prefix",
            "content" = EXCLUDED."content",
            "badge" = COALESCE(EXCLUDED."badge", "deals"."badge"),
            "affiliate_link" = EXCLUDED."affiliate_link",
            "expires_at" = EXCLUDED."expires_at",
            "scheduled_at" = EXCLUDED."scheduled_at",
            "content_status" = EXCLUDED."content_status",
            "published_at" = EXCLUDED."published_at",
            "published_on" = EXCLUDED."published_on",
            "updated_at" = EXCLUDED."updated_at",
            "updated_by_id" = EXCLUDED."updated_by_id"
          RETURNING id`,
          [
            documentId,
            title,
            cashbackText,
            bankOfferText,
            prepaidText,
            content,
            cleanCode(meta.code),
            // couponType is required + load-bearing (a NULL type renders the
            // Deal as a no-code offer — src/utils/offer-visibility.ts) but the
            // DB column has no default: schema sync never applies schema.json
            // defaults. WP has no deal-uniqueness signal and no phase links
            // deals to pools, so import-time deals are always "static". The
            // conflict clause is fill-only (COALESCE), unlike coupons where WP
            // is authoritative: overwriting would flip an editor's "unique"
            // deal back to "static" while leaving its pool link attached.
            "static",
            salePrice,
            mrp,
            discount,
            discountPrefix,
            isAcfTrue(meta.popular_coupon) ? "Recommended" : null,
            affiliateLink,
            expiresAt,
            contentStatus.scheduledAt,
            contentStatus.contentStatus,
            contentStatus.publishedAt,
            contentStatus.publishedAt ? createdAt : null,
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

        // WordPress ACF `deal_store` selected the logo source, not taxonomy
        // membership. Keep real membership from `relations` and use the ACF
        // Store as an image-only logoStore only when the resulting Deal has no
        // real Store membership. `parseAcfTermId` also handles the serialized
        // ACF values that a bare parseInt silently dropped.
        const dealStoreTermId = parseAcfTermId(meta.deal_store);
        await replaceOfferTaxonomyRelations("deals", entityId, {
          termIds: relations,
          logoStoreTermIds: dealStoreTermId ? [dealStoreTermId] : [],
          logoStoreOnlyWithoutStore: true,
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
      } finally {
        dealImagesFinished += 1;
        if (dealImageStatus === "ready") dealImagesReady += 1;
        else if (dealImageStatus === "missing") dealImagesMissing += 1;
        else dealImagesFailed += 1;
        logger.info(
          `[deal-image progress ${dealImagesFinished}/${posts.length}] ` +
            `WordPress Deal ${post.ID}: ${dealImageStatus} ` +
            `(ready=${dealImagesReady}, missing=${dealImagesMissing}, failed=${dealImagesFailed})`,
        );
      }
    })
  );

  await Promise.all(tasks);
  logger.info(`Deals migration complete: ${inserted} inserted, ${failed} failed`);
  logger.info(
    `Deal image progress complete: ${dealImagesFinished}/${posts.length} checked, ` +
      `${dealImagesReady} ready, ${dealImagesMissing} missing, ${dealImagesFailed} failed`,
  );
  if (failed > 0) {
    if (allowPartial) {
      logger.warn(
        `Continuing after ${failed} Deal import failure(s) because ` +
          `--allow-partial-deals was provided. Phase 08 will not be ` +
          `checkpointed, so these Deals are retried on the next run.`,
      );
      return { checkpoint: false };
    }
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

// ── Helpers ──────────────────────────────────────────────────────────
