import { createRequire } from "node:module";
import { wpQuery, getWpPool } from "../db/wp-client.js";
import { pgQuery, getPgPool } from "../db/pg-client.js";
import { logger } from "../utils/logger.js";

const require = createRequire(import.meta.url);
// Single source of truth for the background-removal dedup index: the Strapi
// migration that owns it. On fresh databases that migration no-ops (files
// table doesn't exist before schema sync) and is recorded forever, so the
// importer must re-create the index itself.
const {
  indexSql: bgRemovalIndexSql,
} = require("../../../database/migrations/2026.07.29T00.00.00.add-deal-image-background-removal.js");

import { getImportExclusions } from "../utils/import-exclusions.js";

export async function runPreflight(): Promise<void> {
  logger.info("=== Phase 0: Preflight Checks ===");

  // Test WordPress connection
  logger.info("Testing WordPress MySQL connection...");
  try {
    const [row] = await wpQuery<{ v: string }>("SELECT VERSION() AS v");
    logger.info(`MySQL connected: ${row.v}`);
  } catch (err: any) {
    throw new Error(`WordPress MySQL connection failed: ${err.message}`);
  }

  // Verify WP tables
  const requiredWpTables = [
    "wp_posts",
    "wp_postmeta",
    "wp_terms",
    "wp_term_taxonomy",
    "wp_term_relationships",
    "wp_termmeta",
  ];
  const wpTables = await wpQuery<{ TABLE_NAME: string }>(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE()`
  );
  const wpTableNames = new Set(wpTables.map((t) => t.TABLE_NAME));

  for (const table of requiredWpTables) {
    if (!wpTableNames.has(table)) {
      throw new Error(`Required WordPress table missing: ${table}`);
    }
    logger.info(`  ✓ ${table}`);
  }

  // Check optional WP tables
  const optionalTables = ["wp_uc_coupons", "wp_uc_codes", "wp_yoast_indexable"];
  for (const table of optionalTables) {
    if (wpTableNames.has(table)) {
      logger.info(`  ✓ ${table} (optional)`);
    } else {
      logger.warn(`  ✗ ${table} (optional - not found)`);
    }
  }

  // Test PostgreSQL connection
  logger.info("Testing Strapi PostgreSQL connection...");
  try {
    const [row] = await pgQuery<{ version: string }>("SELECT version()");
    logger.info(`PostgreSQL connected: ${row.version.substring(0, 60)}`);
  } catch (err: any) {
    throw new Error(`Strapi PostgreSQL connection failed: ${err.message}`);
  }

  // Verify Strapi tables
  const requiredPgTables = [
    "stores",
    "brands",
    "categories",
    "banks",
    "coupons",
    "deals",
    "unique_coupon_pools",
    "unique_codes",
    "files",
    "files_related_mph",
    "components_shared_seos",
    "components_shared_faq_items",
  ];
  const pgTables = await pgQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const pgTableNames = new Set(pgTables.map((t) => t.table_name));

  for (const table of requiredPgTables) {
    if (!pgTableNames.has(table)) {
      throw new Error(`Required Strapi table missing: ${table}. Run Strapi bootstrap first.`);
    }
    logger.info(`  ✓ ${table}`);
  }

  // Ensure unique indexes on document_id for idempotent inserts
  const tablesNeedingDocIdIndex = [
    "stores", "brands", "categories", "banks",
    "coupons", "deals", "unique_coupon_pools", "unique_codes", "files",
  ];
  logger.info("Ensuring document_id unique indexes...");
  for (const table of tablesNeedingDocIdIndex) {
    await pgQuery(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_document_id_uq" ON "${table}" ("document_id")`
    );
  }
  // Ensure unique index on files hash for dedup
  await pgQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS "files_hash_uq" ON "files" ("hash") WHERE "hash" IS NOT NULL`
  );
  // Ensure unique index on files_related_mph for idempotent media linking
  await pgQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS "files_related_mph_uq" ON "files_related_mph" ("file_id", "related_id", "related_type", "field")`
  );
  // Background-removal dedup guard (lost on fresh DBs — see the require above)
  await pgQuery(bgRemovalIndexSql);
  logger.info("  ✓ Unique indexes ensured");

  // Discover link tables
  logger.info("Discovering link tables...");
  const linkTables = pgTables
    .map((t) => t.table_name)
    .filter((t) => t.endsWith("_lnk") || t.endsWith("_links") || t.endsWith("_cmps"))
    .sort();
  for (const t of linkTables) {
    logger.info(`  Link table: ${t}`);
  }

  // Print WP summary counts
  // RAW source totals — before the exclusion rules (Articles tree, retired
  // stores) and the publish/future-only lifecycle. The exclusion-aware
  // numbers that match what actually imports come from `yarn migrate:report`.
  logger.info("WordPress data summary (RAW, before exclusions):");
  const [termCount] = await wpQuery<{ c: number }>(
    "SELECT COUNT(*) AS c FROM wp_terms"
  );
  logger.info(`  Terms: ${termCount.c}`);

  const typeBreakdown = await wpQuery<{ choose_type: string; c: number }>(`
    SELECT tm.meta_value AS choose_type, COUNT(*) AS c
    FROM wp_termmeta tm
    WHERE tm.meta_key = 'choose_type'
    GROUP BY tm.meta_value
    ORDER BY c DESC
  `);
  for (const row of typeBreakdown) {
    logger.info(`    ${row.choose_type}: ${row.c}`);
  }

  const [postCount] = await wpQuery<{ c: number }>(
    "SELECT COUNT(*) AS c FROM wp_posts WHERE post_type='post' AND post_status='publish'"
  );
  logger.info(`  Published posts: ${postCount.c}`);

  const dealCount = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_posts p
    JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
    WHERE p.post_type = 'post' AND p.post_status = 'publish'
  `);
  logger.info(`    Deals: ${dealCount[0]?.c || 0}`);
  logger.info(`    Coupons: ${(postCount.c as number) - (dealCount[0]?.c || 0)}`);

  if (wpTableNames.has("wp_uc_coupons")) {
    const [poolCount] = await wpQuery<{ c: number }>(
      "SELECT COUNT(*) AS c FROM wp_uc_coupons"
    );
    logger.info(`  Unique coupon pools: ${poolCount.c}`);
  }

  if (wpTableNames.has("wp_uc_codes")) {
    const [codeCount] = await wpQuery<{ c: number }>(
      "SELECT COUNT(*) AS c FROM wp_uc_codes"
    );
    logger.info(`  Unique codes: ${codeCount.c}`);
  }

  // What the exclusion rules will subtract from the raw totals above.
  const exclusions = await getImportExclusions();
  logger.info(
    `  Will be EXCLUDED by import rules: ` +
      `${exclusions.articleTermIds.size} article term(s), ` +
      `${exclusions.excludedStoreTermIds.size} retired store term(s) ` +
      `(+ every post filed under them — run \`yarn migrate:report\` for the ` +
      `exact post funnel)`,
  );
  if (exclusions.unmatchedStoreNames.length > 0) {
    logger.warn(
      `  ${exclusions.unmatchedStoreNames.length} excluded-store name(s) match ` +
        `no WordPress store term — review them in dry-run-excluded.csv`,
    );
  }

  const [attachmentCount] = await wpQuery<{ c: number }>(
    "SELECT COUNT(*) AS c FROM wp_posts WHERE post_type='attachment'"
  );
  logger.info(`  Attachments: ${attachmentCount.c}`);

  // Check for expiresAt data
  const expiryMeta = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_postmeta
    WHERE meta_key IN ('_action_manager_date', '_expiration-date', 'expiration-date')
    AND post_id IN (SELECT ID FROM wp_posts WHERE post_type='post' AND post_status='publish')
  `);
  logger.info(`  Posts with expiry metadata: ${expiryMeta[0]?.c || 0}`);

  logger.info("Preflight checks passed!");
}
