import { wpQuery } from "../db/wp-client.js";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import pLimit from "p-limit";
import fs from "node:fs";
import path from "node:path";
import {
  setPostMapping,
  getPoolMappingByName,
  getUserMapping,
} from "../utils/id-maps.js";
import { generateDocumentId } from "../utils/strapi-insert.js";
import {
  replaceResolvedOfferTaxonomyRelationBatch,
  resolveOfferTaxonomyRelations,
  normaliseMigratedAffiliateBrandRelations,
  type ResolvedOfferTaxonomyRelations,
} from "../utils/offer-relations.js";
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
import { config } from "../config.js";
import {
  corruptedNoCodeReason,
  isValidAffiliateDestination,
} from "../utils/offer-quality.js";
import { isAcfTrue } from "../utils/acf.js";
import { reconcileMigratedOfferInventory } from "../utils/offer-inventory.js";
import {
  getImportExclusions,
  hasExcludedTerm,
} from "../utils/import-exclusions.js";
import { getWpOfferExpiryRaw } from "../utils/wp-offer-expiry.js";
import {
  couponLogoStoreCandidates,
  loadWpStoreLogoIndex,
} from "../utils/offer-logo-store.js";
import {
  buildCouponContentMediaBatchQueries,
  buildCouponPoolBatchQueries,
  buildCouponRegistryBatchQuery,
  buildCouponUpsertBatchQuery,
} from "../utils/coupon-batch.js";
import { persistBatchWithIsolation } from "../utils/batch-isolation.js";
import { ensureMigrationRegistry } from "../utils/migration-registry.js";
import {
  extractOfferCountries,
  loadProfileOfferCountries,
} from "../utils/offer-country-extract.js";
import { DEFAULT_CONTENT_LOCALE } from "../utils/content-locale.js";

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

type ReviewStatus =
  | "pending"
  | "imported"
  | "excluded"
  | "quarantined"
  | "failed";

type CouponReviewRow = {
  wpId: number;
  title: string;
  status: ReviewStatus;
  notes: string[];
};

type CouponTargetState = {
  hasContentMedia: boolean;
  hasUniquePool: boolean;
};

type PreparedCoupon = {
  post: WpPost;
  documentId: string;
  sourceKey: string;
  values: readonly unknown[];
  contentFileIds: readonly number[];
  resolvedRelations: ResolvedOfferTaxonomyRelations;
  poolId: number | null;
  targetState?: CouponTargetState;
};

type PersistedCoupon = PreparedCoupon & { entityId: number };

function writeCouponReview(rows: Iterable<CouponReviewRow>): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  const values = [...rows].sort((a, b) => a.wpId - b.wpId);
  fs.writeFileSync(
    path.join(config.stateDir, "coupon-review.json"),
    JSON.stringify({ profile: config.profile, total: values.length, rows: values }, null, 2),
  );
}

/**
 * One target snapshot lets fresh/rerun imports skip empty relation cleanup
 * without preserving stale source-owned rows. Missing entries are new Coupons
 * and therefore have no old media or unique-pool links to remove.
 */
async function loadCouponTargetState(
  documentIds: readonly string[],
): Promise<Map<string, CouponTargetState>> {
  if (documentIds.length === 0) return new Map();
  const rows = await pgQuery<{
    document_id: string;
    has_content_media: boolean;
    has_unique_pool: boolean;
  }>(
    `SELECT coupon.document_id,
            EXISTS (
              SELECT 1
                FROM files_related_mph media
               WHERE media.related_id = coupon.id
                 AND media.related_type = 'api::coupon.coupon'
                 AND media.field = 'content'
            ) AS has_content_media,
            EXISTS (
              SELECT 1
                FROM coupons_unique_coupon_pool_lnk pool
               WHERE pool.coupon_id = coupon.id
            ) AS has_unique_pool
       FROM coupons coupon
      WHERE coupon.document_id = ANY($1::varchar[])`,
    [[...documentIds]],
  );
  const state = new Map<string, CouponTargetState>();
  for (const row of rows) {
    state.set(row.document_id, {
      hasContentMedia: row.has_content_media,
      hasUniquePool: row.has_unique_pool,
    });
  }
  logger.info(`Preloaded target state for ${state.size} existing Coupon(s)`);
  return state;
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

async function persistCouponBatchOnce(
  batch: readonly PreparedCoupon[],
): Promise<PersistedCoupon[]> {
  if (batch.length === 0) return [];
  return pgTransaction(async () => {
    const upsert = buildCouponUpsertBatchQuery(
      batch.map((coupon) => coupon.values),
    );
    const insertedRows = await pgQuery<{ id: number; document_id: string }>(
      upsert.sql,
      upsert.params,
    );
    const idByDocumentId = new Map(
      insertedRows.map((row) => [row.document_id, row.id]),
    );
    const persisted = batch.map((coupon) => {
      const entityId = idByDocumentId.get(coupon.documentId);
      if (!entityId) {
        throw new Error(
          `Coupon batch upsert returned no id for WordPress ${coupon.post.ID}`,
        );
      }
      return { ...coupon, entityId };
    });

    const registry = buildCouponRegistryBatchQuery(batch);
    await pgQuery(registry.sql, registry.params);

    await replaceResolvedOfferTaxonomyRelationBatch(
      "coupons",
      persisted.map((coupon) => ({
        entityId: coupon.entityId,
        resolved: coupon.resolvedRelations,
      })),
    );

    for (const query of buildCouponContentMediaBatchQueries(
      persisted.map((coupon) => ({
        entityId: coupon.entityId,
        fileIds: coupon.contentFileIds,
        reconcile:
          coupon.contentFileIds.length > 0 ||
          Boolean(coupon.targetState?.hasContentMedia),
      })),
    )) {
      await pgQuery(query.sql, query.params);
    }

    for (const query of buildCouponPoolBatchQueries(
      persisted.map((coupon) => ({
        entityId: coupon.entityId,
        poolId: coupon.poolId,
        reconcile:
          coupon.poolId !== null ||
          Boolean(coupon.targetState?.hasUniquePool),
      })),
    )) {
      await pgQuery(query.sql, query.params);
    }

    return persisted;
  });
}

export async function runCoupons(): Promise<void> {
  logger.info("=== Phase 7: Coupons Migration ===");

  // Phase 07 supports standalone execution. Do not rely on --clean or an
  // earlier phase having created the ownership registry before the batched
  // raw upsert below runs.
  await ensureMigrationRegistry();
  const enabledOfferCountries = loadProfileOfferCountries(
    config.siteConfigurationFile,
  );

  const sourcePosts = await wpQuery<WpPost>(`
    SELECT p.ID, p.post_title, p.post_name, p.post_content,
           CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
           CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END AS post_date_gmt,
           CASE WHEN CAST(p.post_modified AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified AS CHAR) END AS post_modified,
           CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END AS post_modified_gmt,
           p.post_status, p.post_author
    FROM wp_posts p
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
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
  const review = new Map<number, CouponReviewRow>(
    sourcePosts.map((post) => [
      post.ID,
      { wpId: post.ID, title: post.post_title, status: "pending", notes: [] },
    ]),
  );
  const migrationNow = new Date();
  const lifecyclePosts = sourcePosts.filter((post) => {
    const expiresAt = parseExpiryDate(
      getWpOfferExpiryRaw(allMeta.get(post.ID) || {}),
    );
    return shouldImportMigrationOffer({
      postStatus: post.post_status,
      expiresAt,
      now: migrationNow,
    });
  });
  const lifecyclePostIds = new Set(lifecyclePosts.map((post) => post.ID));
  for (const post of sourcePosts) {
    if (lifecyclePostIds.has(post.ID)) continue;
    const row = review.get(post.ID)!;
    row.status = "excluded";
    row.notes.push("excluded by the shared offer lifecycle policy");
  }

  // Posts filed under an excluded term (Articles tree, Uncategorized,
  // retired stores)
  // are not coupons to import. Excluding them BEFORE expectedDocumentIds means the inventory
  // reconciliation also converges previously imported excluded posts away on
  // a re-import, instead of keeping them alive.
  const [exclusions, allRelations] = await Promise.all([
    getImportExclusions(),
    getTermRelationsBulk(lifecyclePosts.map((post) => post.ID)),
  ]);
  const excludedPosts = lifecyclePosts.filter((post) =>
    hasExcludedTerm(allRelations.get(post.ID) ?? [], exclusions.termIds),
  );
  if (excludedPosts.length > 0) {
    const sample = excludedPosts
      .slice(0, 10)
      .map((post) => `${post.ID} (${post.post_title})`);
    logger.info(
      `Skipping ${excludedPosts.length} excluded post(s) ` +
        `(articles/Uncategorized/retired stores): ${sample.join("; ")}` +
        (excludedPosts.length > sample.length ? "; ..." : ""),
    );
  }
  const excludedPostIds = new Set(excludedPosts.map((post) => post.ID));
  for (const post of excludedPosts) review.get(post.ID)!.status = "excluded";
  const includedPosts = lifecyclePosts.filter((post) => !excludedPostIds.has(post.ID));
  const quarantinedPosts = includedPosts.filter(
    (post) => !isValidAffiliateDestination(clean(allMeta.get(post.ID)?.link)),
  );
  const quarantinedIds = new Set(quarantinedPosts.map((post) => post.ID));
  for (const post of quarantinedPosts) {
    const row = review.get(post.ID)!;
    row.status = "quarantined";
    row.notes.push("missing or invalid affiliate destination");
  }
  if (quarantinedPosts.length > 0) {
    logger.warn(
      `Quarantined ${quarantinedPosts.length} Coupon(s) without a valid affiliate destination`,
    );
  }
  const posts = includedPosts.filter((post) => !quarantinedIds.has(post.ID));

  const expectedDocumentIds = new Set(
    posts.map((post) => generateDocumentId(`coupon:${post.ID}`)),
  );
  await reconcileMigratedOfferInventory("coupons", expectedDocumentIds);

  logger.info(
    `Found ${posts.length} importable coupon posts ` +
      `(${sourcePosts.length - lifecyclePosts.length} non-importable post(s) ` +
      `dropped, ${excludedPosts.length} excluded post(s), ` +
      `${quarantinedPosts.length} quarantined post(s))`,
  );
  if (posts.length === 0) {
    writeCouponReview(review.values());
    return;
  }

  // Coupon `image` was a standalone URL in WordPress. It duplicates a Store
  // logo in most records, so map that path to the image-only logoStore
  // relation instead of uploading tens of thousands of duplicate files.
  // Load it alongside the two target snapshots; these sources are independent.
  const [storeLogoIndex, adminUsers, couponTargetState] = await Promise.all([
    loadWpStoreLogoIndex(),
    // Saved migration maps can outlive a dev database reset. Never trust a
    // mapped Strapi admin ID until confirmed in the active target DB.
    pgQuery<{ id: number }>(`SELECT "id" FROM "admin_users"`),
    loadCouponTargetState([...expectedDocumentIds]),
  ]);
  const validAdminUserIds = new Set(adminUsers.map((user) => user.id));

  let inserted = 0;
  let failed = 0;
  let completed = 0;
  const preparationConcurrency = config.couponConcurrency;
  const batchConcurrency = config.couponBatchConcurrency;
  const batchSize = config.couponBatchSize;
  const prepareLimit = pLimit(preparationConcurrency);
  const batchLimit = pLimit(batchConcurrency);
  const startedAt = Date.now();
  logger.info(
    `Importing ${posts.length} Coupon(s) in batches of ${batchSize} ` +
      `(batch concurrency=${batchConcurrency}, ` +
      `preparation concurrency=${preparationConcurrency})`,
  );

  const markFailure = (post: WpPost, error: unknown): void => {
    failed++;
    const row = review.get(post.ID)!;
    row.status = "failed";
    row.notes.push(String((error as { message?: unknown })?.message ?? error));
    logger.error(
      `Failed to insert coupon ${post.ID} (${post.post_title}): ` +
        `${String((error as { message?: unknown })?.message ?? error)}`,
    );
  };

  const prepareCoupon = async (post: WpPost): Promise<PreparedCoupon> => {
    const meta = allMeta.get(post.ID) || {};
    const relations = allRelations.get(post.ID) || [];
    const sourceKey = `coupon:${post.ID}`;
    const documentId = generateDocumentId(sourceKey);
    const isUnique = meta.unique_coupon === "1" || meta.unique_coupon === "true";
    const uniqueCouponPoolName = clean(meta.unique_coupon_name);
    const [contentMedia, sourceResolvedRelations] = await Promise.all([
      rewriteContentMedia(cleanHtml(stripShortcodes(post.post_content))),
      resolveOfferTaxonomyRelations({
        termIds: relations,
        logoStoreTermIds: couponLogoStoreCandidates(
          meta.image,
          relations,
          storeLogoIndex,
        ),
        logoStoreOnlyWithoutStore: true,
      }),
    ]);
    const { isForAffiliateBrand, resolved: resolvedRelations } =
      normaliseMigratedAffiliateBrandRelations(sourceResolvedRelations);
    const content = contentMedia.html;
    const title = clean(post.post_title) || post.post_title;
    const extractedOfferText = extractOfferText(title, content, {
      currencyCode: config.source.currencyCode,
    });
    const offerText = extractedOfferText ?? "SPECIAL OFFER";
    if (!extractedOfferText) {
      review.get(post.ID)!.notes.push(
        "offerText used final SPECIAL OFFER fallback",
      );
    }
    const { cashbackText, bankOfferText, prepaidText } = extractCashbackFields(
      title,
      content,
      { currencyCode: config.source.currencyCode },
    );
    const offerCountries = extractOfferCountries(
      title,
      content,
      enabledOfferCountries,
    );
    const affiliateLink = clean(meta.link);
    const corruptedCode = corruptedNoCodeReason(meta.code);
    const normalizedCode = corruptedCode ? null : cleanCode(meta.code);
    if (corruptedCode) review.get(post.ID)!.notes.push(corruptedCode);
    const missingRequired = [
      !title.trim() ? "title" : null,
      !offerText.trim() ? "offerText" : null,
      !content?.trim() ? "content" : null,
      !affiliateLink?.trim() ? "affiliateLink" : null,
    ].filter(Boolean);
    if (missingRequired.length > 0) {
      logger.warn(
        `Coupon ${post.ID} (${post.post_title}) has required field gap(s): ` +
          `${missingRequired.join(", ")}. Importing it for editorial repair.`,
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
    const expiresAt = parseExpiryDate(getWpOfferExpiryRaw(meta));
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
    const mappedEditorId = meta._edit_last
      ? getUserMapping(parseInt(meta._edit_last, 10))
      : undefined;
    const editorId =
      mappedEditorId !== undefined && validAdminUserIds.has(mappedEditorId)
        ? mappedEditorId
        : authorId;
    const poolRef =
      isUnique && uniqueCouponPoolName
        ? getPoolMappingByName(uniqueCouponPoolName)
        : undefined;
    if (isUnique && uniqueCouponPoolName && !poolRef) {
      logger.warn(
        `Unique coupon pool not found for coupon ${post.ID} ` +
          `(${post.post_title}): ${uniqueCouponPoolName}`,
      );
    } else if (isUnique && !uniqueCouponPoolName) {
      logger.warn(
        `Unique coupon missing unique_coupon_name for coupon ${post.ID} ` +
          `(${post.post_title})`,
      );
    }

    return {
      post,
      documentId,
      sourceKey,
      values: [
        documentId,
        title,
        offerText,
        cashbackText,
        bankOfferText,
        prepaidText,
        offerCountries,
        content,
        normalizedCode,
        isUnique ? "unique" : "static",
        isAcfTrue(meta.popular_coupon) ? "Recommended" : null,
        affiliateLink,
        expiresAt,
        contentStatus.scheduledAt,
        contentStatus.contentStatus,
        isForAffiliateBrand,
        contentStatus.publishedAt,
        contentStatus.publishedAt ? createdAt : null,
        createdAt,
        updatedAt,
        DEFAULT_CONTENT_LOCALE,
        authorId,
        editorId,
      ],
      contentFileIds: contentMedia.fileIds,
      resolvedRelations,
      poolId: poolRef?.id ?? null,
      targetState: couponTargetState.get(documentId),
    };
  };

  const reportProgress = (): void => {
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    logger.info(
      `Coupon batch progress: ${completed}/${posts.length} ` +
        `(${(completed / elapsedSeconds).toFixed(1)}/s, inserted=${inserted}, ` +
        `failed=${failed}, batchSize=${batchSize}, ` +
        `batchConcurrency=${batchConcurrency})`,
    );
  };

  const tasks = chunked(posts, batchSize).map((postBatch) =>
    batchLimit(async () => {
      const preparedResults = await Promise.all(
        postBatch.map((post) =>
          prepareLimit(async () => {
            try {
              return await prepareCoupon(post);
            } catch (error) {
              markFailure(post, error);
              return null;
            }
          }),
        ),
      );
      const prepared = preparedResults.filter(
        (coupon): coupon is PreparedCoupon => coupon !== null,
      );
      const persisted = await persistBatchWithIsolation({
        batch: prepared,
        persist: persistCouponBatchOnce,
        onRecordFailure: (coupon, error) =>
          markFailure(coupon.post, error),
      });
      for (const coupon of persisted) {
        setPostMapping(coupon.post.ID, {
          id: coupon.entityId,
          documentId: coupon.documentId,
          type: "api::coupon.coupon",
          table: "coupons",
        });
        review.get(coupon.post.ID)!.status = "imported";
      }
      inserted += persisted.length;
      completed += postBatch.length;
      reportProgress();
    }),
  );

  const outcomes = await Promise.allSettled(tasks);
  writeCouponReview(review.values());
  const fatal = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (fatal) throw fatal.reason;
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

// ── Helpers ──────────────────────────────────────────────────────────

function stripShortcodes(content: string): string {
  if (!content) return content;
  return content.replace(/\[\/?\w+[^\]]*\]/g, "").trim();
}
