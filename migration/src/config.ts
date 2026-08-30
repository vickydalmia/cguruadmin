import dotenv from "dotenv";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  allocateCouponConcurrency,
  allocateWorkerConcurrency,
} from "./utils/concurrency-budget.js";
import { migrationProfile, migrationStateDir, profileFile } from "./utils/profile-state.js";
import { validateWpTablePrefix } from "./utils/wp-table.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../.env.migration") });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

function boundedInteger(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = parseInt(optional(key, String(fallback)), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

// Keep the default safe while both production Strapi processes are connected
// to the same managed database (2 x DATABASE_POOL_MAX=5 on the current stack).
// Operators running with Strapi stopped or against a larger backend may raise
// this explicitly for a one-off import.
const pgPoolMax = boundedInteger("PG_POOL_MAX", 10, 4, 50);
const couponConcurrency = allocateCouponConcurrency({
  poolMax: pgPoolMax,
  requestedPreparation: boundedInteger("COUPON_CONCURRENCY", 8, 1, 8),
  requestedBatches: boundedInteger("COUPON_BATCH_CONCURRENCY", 4, 1, 4),
  reserve: 2,
});

export const config = {
  profile: migrationProfile(),
  stateDir: migrationStateDir(),
  siteConfigurationFile: optional("MIGRATION_SITE_CONFIGURATION_FILE")
    ? path.resolve(__dirname, "..", optional("MIGRATION_SITE_CONFIGURATION_FILE"))
    : profileFile("site-configuration.json"),
  exclusionsFile: optional("MIGRATION_EXCLUSIONS_FILE")
    ? path.resolve(__dirname, "..", optional("MIGRATION_EXCLUSIONS_FILE"))
    : profileFile("excluded-stores.csv"),
  source: {
    countryCode: optional("SOURCE_COUNTRY_CODE", migrationProfile() === "usa" ? "US" : "IN"),
    locale: optional("SOURCE_LOCALE", migrationProfile() === "usa" ? "en-US" : "en-IN"),
    currencyCode: optional("SOURCE_CURRENCY_CODE", migrationProfile() === "usa" ? "USD" : "INR"),
    timezone: optional("SOURCE_TIMEZONE", migrationProfile() === "usa" ? "America/New_York" : "Asia/Kolkata"),
    internalHosts: optional("SOURCE_INTERNAL_HOSTS").split(",").map((value) => value.trim()).filter(Boolean),
    expectedStores: parseInt(optional("EXPECTED_STORE_COUNT", migrationProfile() === "usa" ? "549" : "0"), 10) || 0,
    expectedAttachments: parseInt(optional("EXPECTED_ATTACHMENT_COUNT", migrationProfile() === "usa" ? "10360" : "0"), 10) || 0,
    expectedDeals: parseInt(optional("EXPECTED_DEAL_COUNT", migrationProfile() === "usa" ? "0" : "-1"), 10),
    expectedHeroBanners: parseInt(optional("EXPECTED_HERO_BANNER_COUNT", migrationProfile() === "usa" ? "5" : "0"), 10) || 0,
    expectedFeaturedStores: parseInt(optional("EXPECTED_FEATURED_STORE_COUNT", migrationProfile() === "usa" ? "8" : "0"), 10) || 0,
  },
  target: {
    internalHosts: optional("TARGET_INTERNAL_HOSTS").split(",").map((value) => value.trim()).filter(Boolean),
  },
  importWpTrackingScripts:
    optional("IMPORT_WP_TRACKING_SCRIPTS", "false").toLowerCase() === "true",
  ssh: {
    host: optional("SSH_HOST"),
    port: parseInt(optional("SSH_PORT", "22")),
    user: optional("SSH_USER"),
    privateKeyPath: optional("SSH_PRIVATE_KEY_PATH").replace(/^~/, os.homedir()),
    passphrase: optional("SSH_PRIVATE_KEY_PASSPHRASE"),
    // Expected server host-key fingerprint, e.g. "SHA256:abc123...". When set,
    // the tunnel rejects any server whose key does not match (MITM protection).
    // Get it with: ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -
    hostFingerprint: optional("SSH_HOST_FINGERPRINT"),
  },
  wp: {
    host: optional("WP_DB_HOST", "127.0.0.1"),
    port: parseInt(optional("WP_DB_PORT", "3306")),
    user: optional("WP_DB_USER", "root"),
    password: optional("WP_DB_PASSWORD", ""),
    database: required("WP_DB_NAME"),
    tablePrefix: validateWpTablePrefix(optional("WP_TABLE_PREFIX", "wp_")),
  },
  pg: {
    connectionString: required("PG_CONNECTION_STRING"),
    caCertPath: optional("PG_CA_CERT_PATH").replace(/^~/, os.homedir()),
    rejectUnauthorized: optional("PG_SSL_REJECT_UNAUTHORIZED", "true") === "true",
    poolMax: pgPoolMax,
  },
  s3: {
    bucket: optional("S3_BUCKET"),
    // No default: the region is part of the destination bucket's identity and
    // feeds derived s3.amazonaws.com URLs.
    region: optional("S3_REGION"),
    accessKeyId: optional("S3_ACCESS_KEY_ID"),
    secretAccessKey: optional("S3_ACCESS_SECRET"),
    baseUrl: optional("S3_BASE_URL"),
    rootPath: optional("S3_ROOT_PATH", "uploads"),
    endpoint: optional("S3_ENDPOINT"),
  },
  fal: {
    key: optional("FAL_KEY"),
    concurrency:
      parseInt(optional("FAL_BACKGROUND_REMOVAL_CONCURRENCY", "2")) || 2,
    timeoutMs:
      parseInt(optional("FAL_BACKGROUND_REMOVAL_TIMEOUT_MS", "120000")) ||
      120000,
    maxAttempts:
      parseInt(optional("FAL_BACKGROUND_REMOVAL_MAX_ATTEMPTS", "3")) || 3,
  },
  wpUploadsDir: path.resolve(
    __dirname,
    "..",
    optional("WP_UPLOADS_DIR", "../wordpress/wp-content/uploads")
  ),
  batchSize: parseInt(optional("BATCH_SIZE", "5000")),
  mediaConcurrency: parseInt(optional("MEDIA_CONCURRENCY", "10")),
  // Keep taxonomy writes below the shared pool budget and clamp
  // hostile/mistyped values instead of flooding remote PostgreSQL.
  taxonomyConcurrency: allocateWorkerConcurrency({
    poolMax: pgPoolMax,
    requested: boundedInteger("TAXONOMY_CONCURRENCY", 8, 1, 8),
    reserve: 2,
    maximum: 8,
  }),
  // Preparation may acquire PostgreSQL through media/taxonomy resolution.
  // Budget it together with pinned batch transactions, retaining two pool
  // connections for preflight/progress work.
  couponConcurrency: couponConcurrency.preparation,
  // Multi-row Coupon writes amortize remote DB latency. Four concurrent
  // batches leave pool headroom; 500 keeps the 21-column upsert far below PG's
  // 65,535 bind-parameter limit.
  couponBatchSize: Math.max(
    1,
    Math.min(500, parseInt(optional("COUPON_BATCH_SIZE", "250"), 10) || 250),
  ),
  couponBatchConcurrency: couponConcurrency.batches,
  logLevel: optional("LOG_LEVEL", "info"),
};
