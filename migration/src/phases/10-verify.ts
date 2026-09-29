import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { shouldImportMigrationOffer } from "../utils/content-status.js";
import { logger } from "../utils/logger.js";
import { parseExpiryDate } from "../utils/wp-dates.js";
import {
  getWpOfferExpiryRaw,
  type WpOfferExpiryMeta,
} from "../utils/wp-offer-expiry.js";
import { ensureMigrationRegistry } from "../utils/migration-registry.js";
import {
  getImportExclusions,
  loadExcludedStoreNames,
  resolveImportExclusions,
} from "../utils/import-exclusions.js";
import { getAllPoolMappings } from "../utils/id-maps.js";
import { isValidAffiliateDestination } from "../utils/offer-quality.js";
import {
  OFFER_META_ALIASES,
  normaliseOfferMeta,
  sqlMetaKeyList,
} from "../utils/wp-source-fields.js";
import {
  TAXONOMY_DESCRIPTION_TARGETS,
  auditTaxonomyDescriptionCoverage,
  type StrapiTaxonomyDescriptionRow,
  type WpTaxonomyDescriptionRow,
} from "../utils/taxonomy-description-backfill.js";
import {
  classifyTaxonomyTerms,
  formatTaxonomyClassificationReport,
} from "../utils/taxonomy-classification.js";

const VERIFY_META_KEYS = sqlMetaKeyList([
  "_action_manager_date",
  "_expiration-date",
  "_expiration-date-status",
  "expiration-date",
  ...OFFER_META_ALIASES.link,
]);

interface CountCheck {
  entity: string;
  wpCount: number;
  pgCount: number;
  match: boolean;
}

async function countImportableWpOffers(
  kind: "coupon" | "deal",
  now: Date,
): Promise<number> {
  const dealPredicate =
    kind === "deal"
      ? `EXISTS (
           SELECT 1 FROM wp_postmeta
           WHERE post_id = p.ID
             AND meta_key = 'is_deal'
             AND meta_value = 'yes'
         )`
      : `NOT EXISTS (
           SELECT 1 FROM wp_postmeta
           WHERE post_id = p.ID
             AND meta_key = 'is_deal'
             AND meta_value = 'yes'
         )`;
  const posts = await wpQuery<{ ID: number; post_status: string }>(`
    SELECT p.ID, p.post_status
    FROM wp_posts p
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
      AND ${dealPredicate}
  `);

  const metaByPost = new Map<number, WpOfferExpiryMeta>();
  const batchSize = 5_000;
  for (let start = 0; start < posts.length; start += batchSize) {
    const ids = posts.slice(start, start + batchSize).map((post) => post.ID);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await wpQuery<{
      post_id: number;
      meta_key: string;
      meta_value: string;
    }>(
      `SELECT post_id, meta_key, meta_value
       FROM wp_postmeta
       WHERE post_id IN (${placeholders})
         AND meta_key IN (${VERIFY_META_KEYS})`,
      ids,
    );
    for (const row of rows) {
      const meta = metaByPost.get(row.post_id) ?? {};
      meta[row.meta_key] = row.meta_value;
      metaByPost.set(row.post_id, meta);
    }
  }
  // Mirror phases 07/08: the affiliate destination is read through its
  // source aliases so the expected count matches what those phases import.
  for (const [postId, meta] of metaByPost) {
    metaByPost.set(postId, normaliseOfferMeta(meta));
  }

  const lifecycleImportable = posts.filter((post) => {
    const expiresAt = parseExpiryDate(
      getWpOfferExpiryRaw(metaByPost.get(post.ID) ?? {}),
    );
    return shouldImportMigrationOffer({
      postStatus: post.post_status,
      expiresAt,
      now,
    });
  });

  // Mirror phases 07/08: posts filed under an excluded term (Articles tree,
  // Uncategorized, retired stores) never import and must not count here.
  const { termIds: excludedTermIds } = await getImportExclusions();

  const articlePostIds = new Set<number>();
  for (let start = 0; start < lifecycleImportable.length; start += batchSize) {
    const ids = lifecycleImportable
      .slice(start, start + batchSize)
      .map((post) => post.ID);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await wpQuery<{ object_id: number; term_id: number }>(
      `SELECT tr.object_id, tt.term_id
       FROM wp_term_relationships tr
       JOIN wp_term_taxonomy tt
         ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'category'
       WHERE tr.object_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      if (excludedTermIds.has(row.term_id)) articlePostIds.add(row.object_id);
    }
  }
  return lifecycleImportable.filter(
    (post) =>
      !articlePostIds.has(post.ID) &&
      isValidAffiliateDestination(metaByPost.get(post.ID)?.link),
  ).length;
}

export async function runVerification(): Promise<void> {
  logger.info("=== Phase 10: Verification ===");
  await ensureMigrationRegistry();

  const checks: CountCheck[] = [];

  // 1. Count checks
  logger.info("--- Record Count Verification ---");

  // Expected entity counts must mirror how phase 03 actually imports:
  // excluded terms (Articles tree, Uncategorized, retired stores) never
  // import, and an unknown choose_type defaults to Store. Raw termmeta counts
  // would flag every exclusion as a false mismatch.
  const sourceTermRows = await wpQuery<WpTaxonomyDescriptionRow>(`
    SELECT t.term_id, t.name, t.slug, tt.parent, tt.description,
           MAX(CASE WHEN tm.meta_key='choose_type' THEN tm.meta_value END) AS choose_type
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm ON t.term_id = tm.term_id AND tm.meta_key = 'choose_type'
    GROUP BY t.term_id, t.name, t.slug, tt.parent
  `);
  const classification = await classifyTaxonomyTerms(sourceTermRows);
  const termRows = classification.terms;
  logger.info(formatTaxonomyClassificationReport(classification.report));
  // Exclusions read the RAW rows (phase 03 parity): classification would
  // erase the Article(s) choose_type signal.
  const termExclusions = resolveImportExclusions(
    sourceTermRows,
    loadExcludedStoreNames(),
  );
  const expectedByType: Record<string, number> = {
    Store: 0,
    Brand: 0,
    Category: 0,
    Bank: 0,
  };
  for (const term of termRows) {
    if (termExclusions.termIds.has(term.term_id)) continue;
    const chooseType = (term.choose_type || "Store").trim();
    expectedByType[chooseType in expectedByType ? chooseType : "Store"] += 1;
  }

  // A row-count match does not prove the entity content arrived. Phase 03 is
  // checkpointed, so descriptions added in WordPress around a migration can
  // otherwise remain silently blank in Strapi. Require every non-empty,
  // sanitized source description to have non-empty target copy while treating
  // existing Strapi descriptions as editor-owned (exact text need not match).
  const descriptionTargetRows = (
    await Promise.all(
      Object.values(TAXONOMY_DESCRIPTION_TARGETS).map(async ({ table }) => {
        const rows = await pgQuery<
          Omit<StrapiTaxonomyDescriptionRow, "table">
        >(`SELECT id, document_id, name, description FROM "${table}"`);
        return rows.map((row) => ({ ...row, table }));
      }),
    )
  ).flat();
  const descriptionCoverage = auditTaxonomyDescriptionCoverage(
    termRows,
    descriptionTargetRows,
    termExclusions.termIds,
  );
  checks.push({
    entity: "Taxonomy long descriptions",
    wpCount: descriptionCoverage.expected,
    pgCount: descriptionCoverage.present,
    match: descriptionCoverage.gaps.length === 0,
  });
  if (descriptionCoverage.gaps.length > 0) {
    const sample = descriptionCoverage.gaps
      .slice(0, 12)
      .map((gap) => `${gap.table}/${gap.name} (${gap.reason})`)
      .join("; ");
    logger.warn(
      `Taxonomy description gaps: ${descriptionCoverage.gaps.length}; ${sample}` +
        (descriptionCoverage.gaps.length > 12 ? "; ..." : ""),
    );
  }

  const [pgStores] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM stores`);
  checks.push({ entity: "Stores", wpCount: expectedByType.Store, pgCount: pgStores.c, match: expectedByType.Store == pgStores.c });

  const [pgBrands] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM brands`);
  checks.push({ entity: "Brands", wpCount: expectedByType.Brand, pgCount: pgBrands.c, match: expectedByType.Brand == pgBrands.c });

  const [pgCats] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM categories`);
  checks.push({ entity: "Categories", wpCount: expectedByType.Category, pgCount: pgCats.c, match: expectedByType.Category == pgCats.c });

  const [pgBanks] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM banks`);
  checks.push({ entity: "Banks", wpCount: expectedByType.Bank, pgCount: pgBanks.c, match: expectedByType.Bank == pgBanks.c });

  const verificationNow = new Date();

  // Coupons: non-expired publish/future rows only.
  const wpCouponCount = await countImportableWpOffers(
    "coupon",
    verificationNow,
  );
  const [pgCoupons] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM coupons`);
  checks.push({
    entity: "Coupons",
    wpCount: wpCouponCount,
    pgCount: pgCoupons.c,
    match: wpCouponCount == pgCoupons.c,
  });

  // Product Deals use exactly the same lifecycle inclusion rule.
  const wpDealCount = await countImportableWpOffers(
    "deal",
    verificationNow,
  );
  const [pgDeals] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM deals`);
  checks.push({
    entity: "Deals",
    wpCount: wpDealCount,
    pgCount: pgDeals.c,
    match: wpDealCount == pgDeals.c,
  });

  // Unique Coupon Pools
  try {
    const [wpPools] = await wpQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM wp_uc_coupons`);
    const [pgPools] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM unique_coupon_pools`);
    checks.push({ entity: "Pools", wpCount: wpPools.c, pgCount: pgPools.c, match: wpPools.c == pgPools.c });
  } catch {
    logger.warn("Skipping pool count check (table not found)");
  }

  // Unique Codes
  try {
    // Phase 6 collapses equal codes only when Phase 5 resolved their
    // WordPress pool into this Strapi database. An unmapped pool intentionally
    // leaves every source code independent.
    const mappedWpPoolIds = [...getAllPoolMappings().keys()];
    const mappedPoolPredicate =
      mappedWpPoolIds.length > 0
        ? `code.coupon_id IN (${mappedWpPoolIds.map(() => "?").join(",")})`
        : "FALSE";
    const [wpCodes] = await wpQuery<{ c: number }>(`
      SELECT COUNT(*) AS c
      FROM (
        SELECT
          CASE
            WHEN ${mappedPoolPredicate} THEN CONCAT('pool:', code.coupon_id)
            ELSE CONCAT('unlinked:', code.id)
          END AS owner_key,
          BINARY CASE
            WHEN CHAR_LENGTH(TRIM(code.code)) > 0 THEN TRIM(code.code)
            ELSE code.code
          END AS normalized_code
        FROM wp_uc_codes code
        GROUP BY owner_key, normalized_code
      ) effective_codes
    `, mappedWpPoolIds);
    const [pgCodes] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM unique_codes`);
    checks.push({
      entity: "Codes (effective unique inventory)",
      wpCount: wpCodes.c,
      pgCount: pgCodes.c,
      match: wpCodes.c == pgCodes.c,
    });
  } catch {
    logger.warn("Skipping code count check (table not found)");
  }

  // Phase 6a resolves users by trimmed email. Count the same effective source
  // inventory, then count matching admin rows regardless of registry
  // ownership: a hand-created Strapi user with the same email is a valid,
  // deliberate match and must not become migration-owned.
  const wpUserEmails = await wpQuery<{ email: string }>(`
    SELECT LOWER(TRIM(user_email)) AS email
    FROM wp_users
    WHERE user_email IS NOT NULL
      AND TRIM(user_email) <> ''
    GROUP BY LOWER(TRIM(user_email))
  `);
  const [pgUsers] = await pgQuery<{ c: number }>(
    `SELECT COUNT(DISTINCT LOWER(email)) AS c
     FROM admin_users
     WHERE LOWER(email) = ANY($1::text[])`,
    [wpUserEmails.map((user) => user.email)],
  );
  checks.push({
    entity: "Users",
    wpCount: wpUserEmails.length,
    pgCount: pgUsers.c,
    match: wpUserEmails.length == pgUsers.c,
  });

  // Print count results
  for (const check of checks) {
    const status = check.match ? "PASS" : "FAIL";
    const icon = check.match ? "✓" : "✗";
    logger.info(
      `  ${icon} ${check.entity}: WP=${check.wpCount} PG=${check.pgCount} [${status}]`
    );
  }

  // 2. User role + creator-backfill checks
  logger.info("\n--- Users & Creator Backfill ---");

  const [unEditored] = await pgQuery<{ c: number }>(`
    SELECT COUNT(*) AS c
    FROM admin_users u
    JOIN migration_source_entities registry
      ON registry.document_id = u.document_id
     AND registry.target_table = 'admin_users'
    WHERE NOT EXISTS (
      SELECT 1
      FROM admin_users_roles_lnk l
      JOIN admin_roles r ON r.id = l.role_id
      WHERE l.user_id = u.id AND r.code = 'strapi-editor'
    )
  `);
  logger.info(
    `  Migrated users missing Editor role: ${unEditored.c} ${unEditored.c > 0 ? "(⚠ review)" : "✓"}`
  );

  const [couponsNoCreator] = await pgQuery<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM coupons offer
     JOIN migration_source_entities registry
       ON registry.document_id = offer.document_id
      AND registry.target_table = 'coupons'
     WHERE offer.created_by_id IS NULL`
  );
  logger.info(
    `  Coupons with NULL created_by: ${couponsNoCreator.c} (non-zero OK if author was skipped)`
  );

  const [dealsNoCreator] = await pgQuery<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM deals offer
     JOIN migration_source_entities registry
       ON registry.document_id = offer.document_id
      AND registry.target_table = 'deals'
     WHERE offer.created_by_id IS NULL`
  );
  logger.info(
    `  Deals with NULL created_by: ${dealsNoCreator.c} (non-zero OK if author was skipped)`
  );

  // 3. Relationship integrity
  logger.info("\n--- Relationship Integrity ---");

  // Coupons without any taxonomy relation
  const [orphanCoupons] = await pgQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM coupons c
    WHERE NOT EXISTS (SELECT 1 FROM coupons_stores_lnk WHERE coupon_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM coupons_brands_lnk WHERE coupon_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM coupons_categories_lnk WHERE coupon_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM coupons_banks_lnk WHERE coupon_id = c.id)
  `);
  logger.info(
    `  Coupons without taxonomy: ${orphanCoupons.c} ${orphanCoupons.c > 0 ? "(⚠ review)" : "✓"}`
  );

  // Deals without taxonomy
  const [orphanDeals] = await pgQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM deals d
    WHERE NOT EXISTS (SELECT 1 FROM deals_stores_lnk WHERE deal_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM deals_brands_lnk WHERE deal_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM deals_categories_lnk WHERE deal_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM deals_banks_lnk WHERE deal_id = d.id)
  `);
  logger.info(
    `  Deals without taxonomy: ${orphanDeals.c} ${orphanDeals.c > 0 ? "(⚠ review)" : "✓"}`
  );

  // 3. Slug uniqueness (only for entities that have slugs)
  logger.info("\n--- Slug Uniqueness ---");
  for (const table of ["stores", "brands", "categories", "banks"]) {
    const [dupes] = await pgQuery<{ c: number }>(`
      SELECT COUNT(*) AS c FROM (
        SELECT slug, COUNT(*) AS cnt FROM "${table}" GROUP BY slug HAVING COUNT(*) > 1
      ) AS dupes
    `);
    logger.info(
      `  ${table}: ${dupes.c} duplicate slugs ${dupes.c > 0 ? "(⚠)" : "✓"}`
    );
  }

  // 4. SEO component check (only taxonomy tables have SEO)
  logger.info("\n--- SEO Components ---");
  for (const table of ["stores", "brands", "categories", "banks"]) {
    const [total] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM "${table}"`);
    const [withSeo] = await pgQuery<{ c: number }>(`
      SELECT COUNT(DISTINCT entity_id) AS c FROM "${table}_cmps"
      WHERE field = 'seo' AND component_type = 'shared.seo'
    `);
    const pct = total.c > 0 ? Math.round((withSeo.c / total.c) * 100) : 0;
    logger.info(`  ${table}: ${withSeo.c}/${total.c} have SEO (${pct}%)`);
  }

  // 5. Content media: no rich-text field should still reference the old
  // WordPress uploads URLs after content-image rewriting.
  logger.info("\n--- Content Media (residual WP uploads URLs) ---");
  const contentColumns: Array<[string, string]> = [
    ["coupons", "content"],
    ["deals", "content"],
    ["stores", "description"],
    ["brands", "description"],
    ["categories", "description"],
    ["banks", "description"],
  ];
  for (const [table, column] of contentColumns) {
    const [residual] = await pgQuery<{ c: number }>(`
      SELECT COUNT(*) AS c FROM "${table}"
      WHERE "${column}" LIKE '%/wp-content/uploads/%'
    `);
    logger.info(
      `  ${table}.${column}: ${residual.c} rows still reference WP uploads ${
        residual.c > 0 ? "(⚠ images missed)" : "✓"
      }`
    );
  }

  // 6. Sample spot-checks
  logger.info("\n--- Sample Spot Checks ---");

  const sampleStores = await pgQuery<{ name: string; slug: string }>(`
    SELECT name, slug FROM stores ORDER BY RANDOM() LIMIT 5
  `);
  logger.info("  Sample stores:");
  for (const s of sampleStores) {
    logger.info(`    - ${s.name} (${s.slug})`);
  }

  const sampleCoupons = await pgQuery<{
    title: string;
    code: string | null;
    coupon_type: string;
  }>(`
    SELECT title, code, coupon_type FROM coupons ORDER BY RANDOM() LIMIT 5
  `);
  logger.info("  Sample coupons:");
  for (const c of sampleCoupons) {
    logger.info(
      `    - ${c.title} code=${c.code || "N/A"} type=${c.coupon_type}`
    );
  }

  // Summary
  const failedChecks = checks.filter((c) => !c.match);
  if (failedChecks.length === 0) {
    logger.info("\n✓ All count checks passed!");
  } else {
    logger.warn(`\n⚠ ${failedChecks.length} count checks failed:`);
    for (const f of failedChecks) {
      logger.warn(`  - ${f.entity}: expected ${f.wpCount}, got ${f.pgCount}`);
    }
  }
}
