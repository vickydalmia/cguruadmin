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
import { runTaxonomies } from "./phases/03-taxonomies.js";
import { runTags } from "./phases/04-tags.js";
import { runPools } from "./phases/05-pools.js";
import { runCodes } from "./phases/06-codes.js";
import { runCoupons } from "./phases/07-coupons.js";
import { runDeals } from "./phases/08-deals.js";
import { runSeoBackfill } from "./phases/09-seo-backfill.js";
import { runVerification } from "./phases/10-verify.js";
import { runCopyUsedMedia } from "./phases/11-copy-used-media.js";

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
  { name: "04-tags", fn: runTags },
  { name: "05-pools", fn: runPools },
  { name: "06-codes", fn: runCodes },
  { name: "07-coupons", fn: runCoupons },
  { name: "08-deals", fn: runDeals },
  { name: "09-seo-backfill", fn: runSeoBackfill },
  { name: "10-verify", fn: runVerification, skipCheckpoint: true },
  { name: "11-copy-used-media", fn: runCopyUsedMedia },
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
      "coupons_tags_lnk", "coupons_unique_coupon_pool_lnk",
      "deals_stores_lnk", "deals_brands_lnk", "deals_categories_lnk", "deals_banks_lnk",
      "deals_tags_lnk", "deals_display_store_lnk",
      "unique_codes_pool_lnk",
      "files_related_mph",
      // Component join tables
      "stores_cmps", "brands_cmps", "categories_cmps", "banks_cmps",
      // Component data tables
      "components_shared_seos", "components_shared_faq_items",
      // Entity tables
      "coupons", "deals",
      "unique_codes", "unique_coupon_pools",
      "tags",
      "stores", "brands", "categories", "banks",
      // Media (only migration-created records)
      "files",
    ];
    for (const table of tablesToTruncate) {
      try {
        await pool.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
      } catch (err: any) {
        logger.warn(`Could not truncate ${table}: ${err.message}`);
      }
    }
    logger.info("Tables truncated");

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
