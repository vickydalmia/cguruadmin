import { logger } from "./utils/logger.js";
import { loadMaps, saveMaps, clearAllMaps } from "./utils/id-maps.js";
import {
  isPhaseComplete,
  markPhaseComplete,
  clearCheckpoints,
} from "./utils/checkpoint.js";
import { closeWp } from "./db/wp-client.js";
import { closePg, getPgPool } from "./db/pg-client.js";

import { runPreflight } from "./phases/00-preflight.js";
import { runMediaInventory } from "./phases/01-media-inventory.js";
import { runMediaUpload, logMediaUploadStats, clearS3Bucket } from "./phases/02-media-upload.js";
import { logContentMediaStats } from "./utils/content-media.js";
import { runTaxonomies } from "./phases/03-taxonomies.js";
import { runPools } from "./phases/05-pools.js";
import { runCodes } from "./phases/06-codes.js";
import { runUsers } from "./phases/06a-users.js";
import { runCoupons } from "./phases/07-coupons.js";
import { runDeals } from "./phases/08-deals.js";
import { runSeoBackfill } from "./phases/09-seo-backfill.js";
import { runVerification } from "./phases/10-verify.js";
import { runCopyUsedMedia } from "./phases/11-copy-used-media.js";
import { runOfferBackfill } from "./phases/12-offer-backfill.js";
import { runSiteContent } from "./phases/13-site-content.js";
import { runHomepageOfferBackfill } from "./phases/13a-homepage-offer-sections.js";
import { runMediaOptimize } from "./phases/14-media-optimize.js";
import { runMediaFormatsBackfill } from "./phases/15-media-formats-backfill.js";

interface Phase {
  name: string;
  fn: () => Promise<void>;
  skipCheckpoint?: boolean;
}

const phases: Phase[] = [
  { name: "00-preflight", fn: runPreflight, skipCheckpoint: true },
  { name: "01-media-inventory", fn: runMediaInventory },
  { name: "02-media-upload", fn: runMediaUpload },
  { name: "03-taxonomies", fn: runTaxonomies },
  { name: "05-pools", fn: runPools },
  { name: "06-codes", fn: runCodes },
  { name: "06a-users", fn: runUsers },
  { name: "07-coupons", fn: runCoupons },
  { name: "08-deals", fn: runDeals },
  { name: "09-seo-backfill", fn: runSeoBackfill },
  { name: "10-verify", fn: runVerification, skipCheckpoint: true },
  { name: "11-copy-used-media", fn: runCopyUsedMedia },
  { name: "12-offer-backfill", fn: runOfferBackfill },
  { name: "13-site-content", fn: runSiteContent },
  { name: "13a-homepage-offer-sections", fn: runHomepageOfferBackfill },
  { name: "14-media-optimize", fn: runMediaOptimize },
  // Re-runnable by design (candidate SQL is the idempotency guard); a
  // checkpoint would let a --dry-run/--limit pilot mark it complete and make
  // resume-style runs skip the real backfill.
  { name: "15-media-formats-backfill", fn: runMediaFormatsBackfill, skipCheckpoint: true },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const startTime = Date.now();

  logger.info("========================================");
  logger.info("CouponzGuru WordPress -> Strapi Migration");
  logger.info("========================================");

  // Handle --clean flag
  if (args.includes("--clean")) {
    clearCheckpoints();
    clearAllMaps();
    // Truncate all migrated data tables (order matters for foreign keys)
    logger.info("Truncating migrated data from Strapi tables...");
    const pool = getPgPool();
    const tablesToTruncate = [
      // Link/join tables first
      "coupons_stores_lnk", "coupons_brands_lnk", "coupons_categories_lnk", "coupons_banks_lnk",
      "coupons_unique_coupon_pool_lnk",
      "deals_stores_lnk", "deals_brands_lnk", "deals_categories_lnk", "deals_banks_lnk",
      "unique_codes_pool_lnk",
      "files_related_mph",
      // Component join tables
      "stores_cmps", "brands_cmps", "categories_cmps", "banks_cmps",
      // Single-type component joins (phase 13 seeds these; without truncation
      // a re-run sees stale rows and skips seeding)
      "homepages_cmps", "menus_cmps", "footers_cmps", "globals_cmps",
      // Component data tables
      "components_shared_seos", "components_shared_faq_items",
      "components_homepage_slider_slides",
      "components_home_hero_sections", "components_home_hero_products",
      "components_home_top_offers", "components_home_top_offer_items",
      "components_home_popular_stores", "components_home_deal_lists",
      "components_home_cg_exclusives", "components_home_exclusive_items",
      "components_home_explore_deals", "components_home_explore_tabs",
      "components_home_explore_offers", "components_home_explore_offer_tabs",
      "components_home_offer_lists",
      "components_home_newly_addeds", "components_home_coupon_card_items",
      "components_home_bank_offers", "components_home_bank_offer_items",
      "components_home_how_it_works", "components_home_steps",
      "components_home_why_features", "components_home_faq_blocks",
      "components_nav_links", "components_nav_category_sections",
      "components_footer_link_sections", "components_footer_social_links",
      "components_footer_countries", "components_footer_partner_cards",
      // Entity tables
      "coupons", "deals",
      "unique_codes", "unique_coupon_pools",
      "stores", "brands", "categories", "banks",
      // Single types (re-seeded by phase 13)
      "homepages", "menus", "footers", "globals",
      // Media (only migration-created records)
      "files",
    ];

    // Fetch every existing public table once so we can (a) auto-discover the
    // nested component join tables (components_*_cmps) and relation link tables
    // (*_lnk) that Strapi shortens/auto-generates — phase 13 in particular
    // creates many whose exact names are hard to enumerate by hand — and
    // (b) filter the explicit list down to tables that actually exist, so we
    // never warn on legitimately-absent tables (e.g. globals_cmps: the global
    // single type has no component fields, so Strapi never creates it).
    // The prefix allowlist deliberately excludes admin_/up_/strapi_/core
    // tables so we never wipe admin roles or plugin permissions.
    const OWNED_PREFIXES = [
      "components_", "homepages_", "menus_", "footers_", "globals_",
      "coupons_", "deals_", "stores_", "brands_", "categories_", "banks_",
      "unique_codes_", "unique_coupon_pools_",
    ];
    let existingTables = new Set<string>();
    try {
      const rows = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      existingTables = new Set(rows.rows.map((r) => r.table_name));
      for (const name of existingTables) {
        if (
          (name.endsWith("_cmps") || name.endsWith("_lnk")) &&
          OWNED_PREFIXES.some((p) => name.startsWith(p)) &&
          !tablesToTruncate.includes(name)
        ) {
          tablesToTruncate.push(name);
        }
      }
    } catch (err: any) {
      logger.warn(`Could not enumerate tables: ${err.message}`);
    }

    for (const table of tablesToTruncate) {
      // Skip tables that don't exist (e.g. component join tables for single
      // types with no components) — only when we successfully listed tables.
      if (existingTables.size > 0 && !existingTables.has(table)) continue;
      try {
        await pool.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
      } catch (err: any) {
        logger.warn(`Could not truncate ${table}: ${err.message}`);
      }
    }
    logger.info("Tables truncated");

    // Remove only migration-created admin users (wp_<hash> document_id prefix)
    // so the super admin account survives --clean.
    try {
      await pool.query(
        `DELETE FROM "admin_users_roles_lnk"
         WHERE user_id IN (SELECT id FROM "admin_users" WHERE document_id LIKE 'wp\\_%' ESCAPE '\\')`
      );
      const del = await pool.query(
        `DELETE FROM "admin_users" WHERE document_id LIKE 'wp\\_%' ESCAPE '\\'`
      );
      logger.info(`Removed ${del.rowCount ?? 0} migrated admin_users`);
    } catch (err: any) {
      logger.warn(`Could not clean migrated admin_users: ${err.message}`);
    }

    // Clear S3 bucket to avoid orphan files
    await clearS3Bucket();
  }

  // Handle --phase flag to run specific phase
  const phaseIdx = args.indexOf("--phase");
  const specificPhase = phaseIdx !== -1 ? args[phaseIdx + 1] : null;

  // Load saved ID maps
  loadMaps();

  try {
    for (const phase of phases) {
      // Skip if running specific phase and this isn't it
      if (specificPhase && phase.name !== specificPhase) continue;

      // Skip if already completed (unless --clean was used)
      if (!specificPhase && !phase.skipCheckpoint && isPhaseComplete(phase.name)) {
        logger.info(`Skipping ${phase.name} (already complete)`);
        continue;
      }

      const phaseStart = Date.now();
      await phase.fn();
      const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(1);
      logger.info(`${phase.name} completed in ${phaseDuration}s`);

      // Save checkpoint and maps after each phase
      if (!phase.skipCheckpoint) {
        markPhaseComplete(phase.name);
        saveMaps();
      }
    }

    logMediaUploadStats();
    logContentMediaStats();
    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info("========================================");
    logger.info(`Migration completed in ${totalDuration}s`);
    logger.info("========================================");
  } catch (err: any) {
    logger.error(`Migration failed: ${err.message}`);
    logger.error(err.stack);
    saveMaps(); // Save progress even on failure
    process.exit(1);
  } finally {
    await closeWp();
    await closePg();
  }
}

main();
