import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { logger } from "../utils/logger.js";

interface CountCheck {
  entity: string;
  wpCount: number;
  pgCount: number;
  match: boolean;
}

export async function runVerification(): Promise<void> {
  logger.info("=== Phase 10: Verification ===");

  const checks: CountCheck[] = [];

  // 1. Count checks
  logger.info("--- Record Count Verification ---");

  // Stores
  const [wpStores] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Store'
  `);
  const [pgStores] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM stores`);
  checks.push({ entity: "Stores", wpCount: wpStores.c, pgCount: pgStores.c, match: wpStores.c == pgStores.c });

  // Brands
  const [wpBrands] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Brand'
  `);
  const [pgBrands] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM brands`);
  checks.push({ entity: "Brands", wpCount: wpBrands.c, pgCount: pgBrands.c, match: wpBrands.c == pgBrands.c });

  // Categories
  const [wpCats] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Category'
  `);
  const [pgCats] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM categories`);
  checks.push({ entity: "Categories", wpCount: wpCats.c, pgCount: pgCats.c, match: wpCats.c == pgCats.c });

  // Banks
  const [wpBanks] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Bank'
  `);
  const [pgBanks] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM banks`);
  checks.push({ entity: "Banks", wpCount: wpBanks.c, pgCount: pgBanks.c, match: wpBanks.c == pgBanks.c });

  // Tags
  const [wpTags] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_term_taxonomy WHERE taxonomy = 'post_tag'
  `);
  const [pgTags] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM tags`);
  checks.push({ entity: "Tags", wpCount: wpTags.c, pgCount: pgTags.c, match: wpTags.c == pgTags.c });

  // Coupons (non-deals, include future/scheduled)
  const [wpCoupons] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_posts p
    WHERE p.post_type = 'post' AND p.post_status IN ('publish', 'future')
    AND p.ID NOT IN (
      SELECT post_id FROM wp_postmeta WHERE meta_key = 'is_deal' AND meta_value = 'yes'
    )
  `);
  const [pgCoupons] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM coupons`);
  checks.push({ entity: "Coupons", wpCount: wpCoupons.c, pgCount: pgCoupons.c, match: wpCoupons.c == pgCoupons.c });

  // Deals
  const [wpDeals] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_posts p
    JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
    WHERE p.post_type = 'post' AND p.post_status IN ('publish', 'future')
  `);
  const [pgDeals] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM deals`);
  checks.push({ entity: "Deals", wpCount: wpDeals.c, pgCount: pgDeals.c, match: wpDeals.c == pgDeals.c });

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
    const [wpCodes] = await wpQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM wp_uc_codes`);
    const [pgCodes] = await pgQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM unique_codes`);
    checks.push({ entity: "Codes", wpCount: wpCodes.c, pgCount: pgCodes.c, match: wpCodes.c == pgCodes.c });
  } catch {
    logger.warn("Skipping code count check (table not found)");
  }

  // Users (migrated admin users — authors of published/future posts)
  const [wpAuthors] = await wpQuery<{ c: number }>(`
    SELECT COUNT(DISTINCT post_author) AS c FROM wp_posts
    WHERE post_type = 'post' AND post_status IN ('publish', 'future')
  `);
  const [pgUsers] = await pgQuery<{ c: number }>(
    `SELECT COUNT(*) AS c FROM admin_users WHERE document_id LIKE 'wp\\_%' ESCAPE '\\'`
  );
  checks.push({
    entity: "Users",
    wpCount: wpAuthors.c,
    pgCount: pgUsers.c,
    match: wpAuthors.c == pgUsers.c,
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
    LEFT JOIN admin_users_roles_lnk l ON l.user_id = u.id
    LEFT JOIN admin_roles r ON r.id = l.role_id
    WHERE u.document_id LIKE 'wp\\_%' ESCAPE '\\'
      AND (r.code IS NULL OR r.code <> 'strapi-editor')
  `);
  logger.info(
    `  Migrated users missing Editor role: ${unEditored.c} ${unEditored.c > 0 ? "(⚠ review)" : "✓"}`
  );

  const [couponsNoCreator] = await pgQuery<{ c: number }>(
    `SELECT COUNT(*) AS c FROM coupons WHERE document_id LIKE 'wp\\_%' ESCAPE '\\' AND created_by_id IS NULL`
  );
  logger.info(
    `  Coupons with NULL created_by: ${couponsNoCreator.c} (non-zero OK if author was skipped)`
  );

  const [dealsNoCreator] = await pgQuery<{ c: number }>(
    `SELECT COUNT(*) AS c FROM deals WHERE document_id LIKE 'wp\\_%' ESCAPE '\\' AND created_by_id IS NULL`
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
  for (const table of ["stores", "brands", "categories", "banks", "tags"]) {
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

  // 5. Sample spot-checks
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
