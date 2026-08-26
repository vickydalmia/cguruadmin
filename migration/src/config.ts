import dotenv from "dotenv";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
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
    expectedStores: parseInt(optional("EXPECTED_STORE_COUNT", migrationProfile() === "usa" ? "7162" : "0"), 10) || 0,
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
  logLevel: optional("LOG_LEVEL", "info"),
};
