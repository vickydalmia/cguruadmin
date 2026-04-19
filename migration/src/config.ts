import dotenv from "dotenv";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

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
  ssh: {
    host: optional("SSH_HOST"),
    port: parseInt(optional("SSH_PORT", "22")),
    user: optional("SSH_USER"),
    privateKeyPath: optional("SSH_PRIVATE_KEY_PATH").replace(/^~/, os.homedir()),
  },
  wp: {
    host: optional("WP_DB_HOST", "127.0.0.1"),
    port: parseInt(optional("WP_DB_PORT", "3306")),
    user: optional("WP_DB_USER", "root"),
    password: optional("WP_DB_PASSWORD", ""),
    database: required("WP_DB_NAME"),
  },
  pg: {
    connectionString: required("PG_CONNECTION_STRING"),
    caCertPath: optional("PG_CA_CERT_PATH").replace(/^~/, os.homedir()),
    rejectUnauthorized: optional("PG_SSL_REJECT_UNAUTHORIZED", "true") === "true",
  },
  s3: {
    bucket: optional("S3_BUCKET"),
    region: optional("S3_REGION", "ap-south-1"),
    accessKeyId: optional("S3_ACCESS_KEY_ID"),
    secretAccessKey: optional("S3_ACCESS_SECRET"),
    baseUrl: optional("S3_BASE_URL"),
    rootPath: optional("S3_ROOT_PATH", "uploads"),
    endpoint: optional("S3_ENDPOINT"),
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
