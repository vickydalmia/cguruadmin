import { createRequire } from "node:module";
import { wpQuery, getWpPool, wpTable } from "../db/wp-client.js";
import { pgQuery, getPgPool } from "../db/pg-client.js";
import { logger } from "../utils/logger.js";
import fs from "node:fs";
import { config } from "../config.js";
import {
  OFFER_RELATION_UNIQUE_INDEXES,
  relationUniqueIndexSql,
} from "../utils/relation-indexes.js";

const require = createRequire(import.meta.url);
// Single source of truth for the background-removal dedup index: the Strapi
// migration that owns it. On fresh databases that migration no-ops (files
// table doesn't exist before schema sync) and is recorded forever, so the
// importer must re-create the index itself.
const {
  indexSql: bgRemovalIndexSql,
} = require("../../../database/migrations/2026.07.29T00.00.00.add-deal-image-background-removal.js");

import { getImportExclusions } from "../utils/import-exclusions.js";
import {
  classifyTaxonomyTerms,
  formatTaxonomyClassificationReport,
} from "../utils/taxonomy-classification.js";
import { loadProfileOfferCountries } from "../utils/offer-country-extract.js";

type PreflightTaxonomyTerm = {
  term_id: number;
  name: string;
  slug: string;
  parent: number;
  choose_type: string | null;
};

const SITE_CONFIGURATION_BOOLEAN_FIELDS = [
  "onboardingComplete",
  "storesEnabled",
  "couponsEnabled",
  "brandsEnabled",
  "categoriesEnabled",
  "banksEnabled",
  "productDealsEnabled",
  "aboutEnabled",
  "careersEnabled",
  "contactEnabled",
  "faqsEnabled",
  "testimonialsEnabled",
  "partnerWithUsEnabled",
  "cultureEnabled",
  "privacyPolicyEnabled",
  "termsAndConditionsEnabled",
  "affiliateDisclosureEnabled",
] as const;

function validateSiteConfigurationProfile(): void {
  if (!fs.existsSync(config.siteConfigurationFile)) {
    throw new Error(`Missing profile site configuration: ${config.siteConfigurationFile}`);
  }

  let profile: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(config.siteConfigurationFile, "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    profile = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid profile site configuration ${config.siteConfigurationFile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  for (const field of ["siteName", "countryName"] as const) {
    if (typeof profile[field] !== "string" || !profile[field].trim()) {
      throw new Error(`Profile site configuration requires a non-empty ${field}`);
    }
  }

  const expectedIdentity = {
    countryCode: config.source.countryCode.toUpperCase(),
    locale: config.source.locale,
    timezone: config.source.timezone,
    currencyCode: config.source.currencyCode.toUpperCase(),
  };
  for (const [field, expected] of Object.entries(expectedIdentity)) {
    const actual =
      field === "countryCode" || field === "currencyCode"
        ? String(profile[field] ?? "").toUpperCase()
        : profile[field];
    if (actual !== expected) {
      throw new Error(
        `Profile ${field} (${String(profile[field] ?? "missing")}) does not match source configuration (${expected})`,
      );
    }
  }

  for (const field of SITE_CONFIGURATION_BOOLEAN_FIELDS) {
    if (typeof profile[field] !== "boolean") {
      throw new Error(`Profile site configuration requires boolean ${field}`);
    }
  }
  loadProfileOfferCountries(config.siteConfigurationFile);
}

async function validateSourceDataExceptions(): Promise<void> {
  const exclusions = await getImportExclusions();

  const [attachmentCount] = await wpQuery<{ c: number }>(
    "SELECT COUNT(*) AS c FROM wp_posts WHERE post_type='attachment'",
  );
  if (
    config.source.expectedAttachments > 0 &&
    Number(attachmentCount.c) !== config.source.expectedAttachments
  ) {
    logger.warn(
      `Attachment count drift (non-blocking): expected ${config.source.expectedAttachments}, ` +
        `found ${attachmentCount.c}. Phase 01 will report files missing from the local uploads tree; ` +
        `reconcile newly added source attachments after this run.`,
    );
  }

  const sourceStoreTerms = await wpQuery<PreflightTaxonomyTerm>(`
    SELECT t.term_id, t.name, t.slug, tt.parent,
           MAX(CASE WHEN tm.meta_key = 'choose_type' THEN tm.meta_value END) AS choose_type
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON tt.term_id = t.term_id AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm ON tm.term_id = t.term_id AND tm.meta_key = 'choose_type'
    GROUP BY t.term_id, t.name, t.slug, tt.parent
  `);
  const { terms: storeTerms } = await classifyTaxonomyTerms(sourceStoreTerms);
  const nonStoreTypes = new Set(["Brand", "Category", "Bank"]);
  const importableStoreCount = storeTerms.filter(
    (term) =>
      !exclusions.termIds.has(term.term_id) &&
      !nonStoreTypes.has(term.choose_type?.trim() || "Store"),
  ).length;
  if (
    config.source.expectedStores > 0 &&
    importableStoreCount !== config.source.expectedStores
  ) {
    throw new Error(
      `Store count exception: expected ${config.source.expectedStores}, found ${importableStoreCount}`,
    );
  }

  const [dealCount] = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_posts p
    JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
    WHERE p.post_type = 'post' AND p.post_status IN ('publish', 'future')
  `);
  if (
    config.source.expectedDeals >= 0 &&
    Number(dealCount?.c ?? 0) !== config.source.expectedDeals
  ) {
    throw new Error(
      `Deal count exception: expected ${config.source.expectedDeals}, found ${dealCount?.c ?? 0}`,
    );
  }
}

export async function runPreflight(): Promise<void> {
  logger.info("=== Phase 0: Preflight Checks ===");

  if (!/^[A-Z]{2}$/u.test(config.source.countryCode.toUpperCase())) {
    throw new Error("SOURCE_COUNTRY_CODE must be a two-letter ISO country code");
  }
  Intl.getCanonicalLocales(config.source.locale);
  if (!Intl.supportedValuesOf("currency").includes(config.source.currencyCode.toUpperCase())) {
    throw new Error(`Unsupported SOURCE_CURRENCY_CODE: ${config.source.currencyCode}`);
  }
  new Intl.DateTimeFormat(config.source.locale, { timeZone: config.source.timezone }).format();
  validateSiteConfigurationProfile();
  logger.info(
    `Profile ${config.profile}: ${config.source.countryCode}/${config.source.locale}/${config.source.currencyCode}, prefix ${config.wp.tablePrefix}, state ${config.stateDir}`,
  );

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
    wpTable("posts"),
    wpTable("postmeta"),
    wpTable("terms"),
    wpTable("term_taxonomy"),
    wpTable("term_relationships"),
    wpTable("termmeta"),
    wpTable("users"),
    wpTable("usermeta"),
    wpTable("options"),
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
  const optionalTables = [wpTable("uc_coupons"), wpTable("uc_codes"), wpTable("yoast_indexable")];
  for (const table of optionalTables) {
    if (wpTableNames.has(table)) {
      logger.info(`  ✓ ${table} (optional)`);
    } else {
      logger.warn(`  ✗ ${table} (optional - not found)`);
    }
  }

  // Validate source identity and hard inventory exceptions before opening or
  // mutating the destination. Attachment totals are advisory because a live
  // WordPress site can add media after the paired DB/files snapshot; Phase 01
  // reports whether the actual source files are locally available.
  await validateSourceDataExceptions();

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
    ...OFFER_RELATION_UNIQUE_INDEXES.map((spec) => spec.table),
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

  // Destination↔profile guard, BEFORE anything mutates the target: a DB
  // already configured for another country means the destination env vars
  // still point at that country's stack (the classic merged-overlay mistake)
  // — refuse rather than import into (or later wipe) the wrong database.
  if (pgTableNames.has("site_configurations")) {
    const [siteConfigRow] = await pgQuery<{ country_code: string | null }>(
      `SELECT country_code FROM "site_configurations" ORDER BY id ASC LIMIT 1`,
    );
    const existingCountry = siteConfigRow?.country_code?.trim().toUpperCase();
    const targetCountry = config.source.countryCode.toUpperCase();
    if (
      existingCountry &&
      existingCountry !== targetCountry &&
      process.env.MIGRATION_ALLOW_COUNTRY_SWITCH !== "true"
    ) {
      throw new Error(
        `Target database is configured for country "${existingCountry}" but profile "${config.profile}" imports "${targetCountry}". ` +
          "Fix the destination env vars (PG_CONNECTION_STRING, S3 bucket) or set MIGRATION_ALLOW_COUNTRY_SWITCH=true to deliberately repurpose this database.",
      );
    }
    if (existingCountry) {
      logger.info(`  ✓ target country matches profile (${existingCountry})`);
    }
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
  // Batch relation upserts name their conflict columns explicitly. Strapi
  // normally creates these pair indexes, but preflight owns the guarantee so
  // a drifted/mixed-version target fails before Phase 07/08 starts writing.
  for (const spec of OFFER_RELATION_UNIQUE_INDEXES) {
    await pgQuery(relationUniqueIndexSql(spec));
    const [verification] = await pgQuery<{ valid: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_index index_meta
           JOIN pg_class table_meta ON table_meta.oid = index_meta.indrelid
           JOIN pg_namespace namespace_meta
             ON namespace_meta.oid = table_meta.relnamespace
          WHERE namespace_meta.nspname = current_schema()
            AND table_meta.relname = $1
            AND index_meta.indisunique
            AND index_meta.indisvalid
            AND index_meta.indpred IS NULL
            AND index_meta.indexprs IS NULL
            AND (
              SELECT array_agg(attribute_meta.attname::text ORDER BY attribute_meta.attname::text)
                FROM unnest(index_meta.indkey) WITH ORDINALITY
                  AS index_key(attnum, position)
                JOIN pg_attribute attribute_meta
                  ON attribute_meta.attrelid = table_meta.oid
                 AND attribute_meta.attnum = index_key.attnum
               WHERE index_key.position <= index_meta.indnkeyatts
            ) = $2::text[]
       ) AS valid`,
      [spec.table, [...spec.columns].sort()],
    );
    if (!verification?.valid) {
      throw new Error(
        `Required unique relation index missing on ${spec.table} ` +
          `(${spec.columns.join(", ")})`,
      );
    }
  }
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
  // RAW source totals — before the exclusion rules (Articles tree,
  // Uncategorized, retired stores) and the offer lifecycle. The exclusion-aware
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

  if (wpTableNames.has(wpTable("uc_coupons"))) {
    const [poolCount] = await wpQuery<{ c: number }>(
      "SELECT COUNT(*) AS c FROM wp_uc_coupons"
    );
    logger.info(`  Unique coupon pools: ${poolCount.c}`);
  }

  if (wpTableNames.has(wpTable("uc_codes"))) {
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
      `${exclusions.uncategorizedTermIds.size} Uncategorized term(s), ` +
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

  const sourceStoreTerms = await wpQuery<PreflightTaxonomyTerm>(`
    SELECT t.term_id, t.name, t.slug, tt.parent,
           MAX(CASE WHEN tm.meta_key = 'choose_type' THEN tm.meta_value END) AS choose_type
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON tt.term_id = t.term_id AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm ON tm.term_id = t.term_id AND tm.meta_key = 'choose_type'
    GROUP BY t.term_id, t.name, t.slug, tt.parent
  `);
  const classification = await classifyTaxonomyTerms(sourceStoreTerms);
  const storeTerms = classification.terms;
  logger.info(`  ${formatTaxonomyClassificationReport(classification.report)}`);
  const nonStoreTypes = new Set(["Brand", "Category", "Bank"]);
  const importableStoreCount = storeTerms.filter(
    (term) =>
      !exclusions.termIds.has(term.term_id) &&
      !nonStoreTypes.has(term.choose_type?.trim() || "Store"),
  ).length;
  logger.info(`  Importable stores after exclusions: ${importableStoreCount}`);

  // Check for expiresAt data
  const expiryMeta = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c FROM wp_postmeta
    WHERE meta_key IN ('_action_manager_date', '_expiration-date', 'expiration-date')
    AND post_id IN (SELECT ID FROM wp_posts WHERE post_type='post' AND post_status='publish')
  `);
  logger.info(`  Posts with expiry metadata: ${expiryMeta[0]?.c || 0}`);

  logger.info("Preflight checks passed!");
}
