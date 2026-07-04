import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import { pgQuery } from "../db/pg-client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  optimizeOriginal,
  generateStrapiFormats,
} from "../utils/image-optimizer.js";
import { getS3Client, hashBuffer } from "./02-media-upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_DIR = path.resolve(__dirname, "../../.checkpoints");
const HASH_MAP_CACHE = path.join(CHECKPOINT_DIR, "media-hash-map.json");

const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** File extensions worth hashing when scanning the WP uploads tree. */
const SOURCE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tif",
  ".tiff",
]);

interface CandidateRow {
  id: number;
  document_id: string;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  url: string;
  provider_metadata: any;
}

interface HashCacheEntry {
  mtime: number;
  size: number;
  hash: string;
}

/**
 * Phase 14 — Media Optimize (backfill)
 *
 * Optimizes already-migrated S3 images that predate the optimization
 * pipeline (rows with formats IS NULL):
 *   - re-encodes the original (max 1920px, jpeg/png → webp, quality 80)
 *   - uploads Strapi-style responsive variants (thumbnail/small/medium/large)
 *   - updates the files row (formats/ext/mime/url/width/height/size) in a
 *     single UPDATE as the LAST step, so a crash leaves the row eligible
 *   - deletes the superseded S3 object when the key changed (jpeg/png →
 *     webp) unless --keep-originals is passed
 *
 * Row-level idempotency comes from the candidate predicate (formats IS NULL).
 */
export async function runMediaOptimize(): Promise<void> {
  logger.info("=== Phase 14: Media Optimize (formats backfill + webp) ===");

  const keepOriginals = process.argv.includes("--keep-originals");
  if (keepOriginals) {
    logger.info("--keep-originals: superseded S3 objects will NOT be deleted");
  }

  // Guard: an empty files table means media was never migrated here.
  const [{ count }] = await pgQuery<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM files"
  );
  if (Number(count) === 0) {
    throw new Error(
      "Strapi `files` table is empty — there is no migrated media to optimize. " +
        "Run a full migration first: npm run migrate -- --clean"
    );
  }

  if (!config.s3.bucket || !config.s3.accessKeyId) {
    logger.warn("S3 not configured — skipping media optimization backfill");
    return;
  }

  const candidates = await pgQuery<CandidateRow>(
    `SELECT id, document_id, name, hash, ext, mime, url, provider_metadata
     FROM files
     WHERE provider = 'aws-s3'
       AND formats IS NULL
       AND mime IN ('image/jpeg','image/png','image/webp','image/avif','image/tiff')
     ORDER BY id`
  );

  if (candidates.length === 0) {
    logger.info("No unoptimized media found — nothing to do");
    return;
  }
  logger.info(`Found ${candidates.length} unoptimized media files`);

  // Map sha256(file)[0:16] → local path for every image in the WP uploads
  // tree (the same hash Phase 02 stored in files.hash).
  const localByHash = buildLocalHashMap();

  const client = getS3Client();
  const rootPrefix = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
  const urlPrefix = config.s3.baseUrl
    ? config.s3.baseUrl.replace(/\/+$/, "")
    : `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;

  const stats = {
    optimized: 0,
    converted: 0,
    variantsUploaded: 0,
    deletedOld: 0,
    skippedNoSource: 0,
    failed: 0,
  };
  let processed = 0;

  const limit = pLimit(5);
  await Promise.all(
    candidates.map((row) =>
      limit(async () => {
        try {
          await processRow(row, {
            client,
            localByHash,
            rootPrefix,
            urlPrefix,
            keepOriginals,
            stats,
          });
        } catch (err: any) {
          stats.failed++;
          logger.error(
            `Failed to optimize file ${row.id} (${row.name}): ${err.message}`
          );
        } finally {
          processed++;
          if (processed % 100 === 0) {
            logger.info(
              `  Media optimize progress: ${processed}/${candidates.length} ` +
                `(optimized=${stats.optimized}, converted=${stats.converted}, ` +
                `skipped=${stats.skippedNoSource}, failed=${stats.failed})`
            );
          }
        }
      })
    )
  );

  logger.info(
    `Media optimize complete: optimized=${stats.optimized}, ` +
      `converted→webp=${stats.converted}, variants uploaded=${stats.variantsUploaded}, ` +
      `deleted old objects=${stats.deletedOld}, skipped (no source)=${stats.skippedNoSource}, ` +
      `failed=${stats.failed}`
  );
}

interface ProcessContext {
  client: ReturnType<typeof getS3Client>;
  localByHash: Map<string, string>;
  rootPrefix: string;
  urlPrefix: string;
  keepOriginals: boolean;
  stats: {
    optimized: number;
    converted: number;
    variantsUploaded: number;
    deletedOld: number;
    skippedNoSource: number;
    failed: number;
  };
}

async function processRow(row: CandidateRow, ctx: ProcessContext): Promise<void> {
  const { client, localByHash, rootPrefix, urlPrefix, keepOriginals, stats } = ctx;

  const meta = parseProviderMetadata(row.provider_metadata);
  const nameNoExt = path.basename(row.name, path.extname(row.name));
  const oldKey: string =
    meta?.key || `${rootPrefix}${row.hash}_${nameNoExt}${row.ext}`;

  // Source bytes: local WP uploads file first, S3 object as fallback.
  let source: Buffer | null = null;
  const localPath = localByHash.get(row.hash);
  if (localPath) {
    try {
      source = fs.readFileSync(localPath);
    } catch {
      source = null;
    }
  }
  if (!source) {
    source = await fetchFromS3(client, oldKey);
  }
  if (!source) {
    stats.skippedNoSource++;
    logger.warn(
      `No source found for file ${row.id} (${row.name}, hash=${row.hash}, key=${oldKey})`
    );
    return;
  }

  const optimized = await optimizeOriginal(source);
  if (!optimized) {
    // Predicate mimes should always be optimizable; a null here means the
    // bytes were not decodable (or animated) — leave the row untouched.
    stats.failed++;
    logger.warn(`Could not optimize file ${row.id} (${row.name}) — skipping`);
    return;
  }

  const newKey = `${rootPrefix}${row.hash}_${nameNoExt}${optimized.ext}`;

  // 1. Upload the optimized original.
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: newKey,
      Body: optimized.buffer,
      ContentType: optimized.mime,
      CacheControl: CACHE_CONTROL,
    })
  );

  // 2. Generate + upload responsive variants.
  const { formatsJson, uploads } = await generateStrapiFormats(
    optimized.buffer,
    {
      width: optimized.width,
      height: optimized.height,
      ext: optimized.ext,
      mime: optimized.mime,
      hashBase: `${row.hash}_${nameNoExt}`,
      nameBase: nameNoExt,
      urlPrefix,
      keyPrefix: rootPrefix,
    }
  );
  for (const variant of uploads) {
    await client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: variant.key,
        Body: variant.buffer,
        ContentType: variant.contentType,
        CacheControl: CACHE_CONTROL,
      })
    );
  }

  // 3. Single UPDATE — last DB step, so a crash before this point leaves the
  //    row matching the candidate predicate (formats IS NULL) for re-runs.
  //    formats is written even when empty ({}) so tiny images don't stay
  //    eligible forever. Size stays in the same unit existing rows use
  //    (bytes / 1024, rounded to 2dp — see Phase 02).
  const newUrl = `${urlPrefix}/${newKey}`;
  const newMeta = { ...(meta || {}), key: newKey };
  await pgQuery(
    `UPDATE files
     SET formats = $1::jsonb,
         ext = $2,
         mime = $3,
         url = $4,
         width = $5,
         height = $6,
         size = $7,
         provider_metadata = $8::jsonb,
         updated_at = NOW()
     WHERE id = $9`,
    [
      JSON.stringify(formatsJson),
      optimized.ext,
      optimized.mime,
      newUrl,
      optimized.width,
      optimized.height,
      parseFloat((optimized.sizeInBytes / 1024).toFixed(2)),
      JSON.stringify(newMeta),
      row.id,
    ]
  );

  stats.optimized++;
  stats.variantsUploaded += uploads.length;
  if (optimized.converted) stats.converted++;

  // 4. Delete the superseded object when the key changed (ext → .webp).
  if (optimized.converted && newKey !== oldKey && !keepOriginals) {
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: oldKey })
      );
      stats.deletedOld++;
    } catch (err: any) {
      logger.warn(`Could not delete old S3 object ${oldKey}: ${err.message}`);
    }
  }
}

// ── Source resolution helpers ────────────────────────────────────────

function parseProviderMetadata(raw: any): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchFromS3(
  client: ReturnType<typeof getS3Client>,
  key: string
): Promise<Buffer | null> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: key })
    );
    const bytes = await response.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch {
    return null;
  }
}

/**
 * Build a map of sha256(file)[0:16] → absolute path for every image file
 * under config.wpUploadsDir (matching how Phase 02 hashes source bytes).
 * Hashes are cached in .checkpoints/media-hash-map.json keyed by
 * mtime + size so re-runs don't rehash unchanged files.
 */
function buildLocalHashMap(): Map<string, string> {
  const map = new Map<string, string>();

  if (!fs.existsSync(config.wpUploadsDir)) {
    logger.warn(
      `WP uploads dir not found at ${config.wpUploadsDir} — will fall back to S3 downloads`
    );
    return map;
  }

  let cache: Record<string, HashCacheEntry> = {};
  if (fs.existsSync(HASH_MAP_CACHE)) {
    try {
      cache = JSON.parse(fs.readFileSync(HASH_MAP_CACHE, "utf8"));
    } catch {
      cache = {};
    }
  }

  let hashed = 0;
  let cached = 0;
  const nextCache: Record<string, HashCacheEntry> = {};

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        const prev = cache[fullPath];
        let hash: string;
        if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) {
          hash = prev.hash;
          cached++;
        } else {
          hash = hashBuffer(fs.readFileSync(fullPath));
          hashed++;
        }
        nextCache[fullPath] = { mtime: stat.mtimeMs, size: stat.size, hash };
        if (!map.has(hash)) map.set(hash, fullPath);
      } catch {
        // unreadable file — skip
      }
    }
  };

  const start = Date.now();
  walk(config.wpUploadsDir);

  try {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    fs.writeFileSync(HASH_MAP_CACHE, JSON.stringify(nextCache));
  } catch (err: any) {
    logger.warn(`Could not persist media hash map cache: ${err.message}`);
  }

  logger.info(
    `Local media hash map ready: ${map.size} files ` +
      `(${hashed} hashed, ${cached} from cache, ${((Date.now() - start) / 1000).toFixed(1)}s)`
  );
  return map;
}
