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
  BREAKPOINTS,
  decodeOrientedDims,
  optimizeOriginal,
  generateStrapiFormats,
  generateAvifTwins,
  slugifyFileName,
  splitS3Key,
} from "../utils/image-optimizer.js";
import {
  buildAvifGapWhere,
  mergeAvifTombstones,
  missingAvifTwinKeys,
  readAvifTombstones,
} from "../utils/format-gaps.js";
import { getS3Client, hashBuffer } from "./02-media-upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_DIR = path.resolve(__dirname, "../../.checkpoints");
// `*Map.json` survives clearCheckpoints(), so --clean no longer forces a
// full rehash of the uploads tree. The old name is read once as a fallback.
const HASH_MAP_CACHE = path.join(CHECKPOINT_DIR, "mediaHashMap.json");
const LEGACY_HASH_MAP_CACHE = path.join(CHECKPOINT_DIR, "media-hash-map.json");

export const CACHE_CONTROL = "public, max-age=31536000, immutable";

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
 * Pass 1 — optimizes already-migrated S3 images that predate the optimization
 * pipeline (rows with formats IS NULL):
 *   - re-encodes the original (max 1920px, jpeg/png → webp, quality 80)
 *   - uploads Strapi-style responsive variants (thumbnail/small/medium/large)
 *     plus AVIF twins (original_avif/small_avif/medium_avif/large_avif)
 *   - updates the files row (formats/ext/mime/url/width/height/size) in a
 *     single UPDATE as the LAST step, so a crash leaves the row eligible
 *   - deletes the superseded S3 object when the key changed (jpeg/png →
 *     webp) unless --keep-originals is passed
 *
 * Pass 2 — add-avif-only backfill for rows that already have formats but are
 * missing any due, non-tombstoned AVIF twin: encodes only those gaps from the
 * best available source bytes, uploads them, and merges the new keys into
 * formats with `formats || $new` in a single UPDATE. Twins the size guard drops are
 * tombstoned in provider_metadata.avifDropped (same UPDATE, or a
 * tombstone-only UPDATE when every twin dropped) and excluded from the
 * candidate predicate, so guard-dropped rows converge instead of re-encoding
 * every run. --keep-originals is a no-op here.
 *
 * Row-level idempotency comes from the candidate predicates (pass 1: formats
 * IS NULL; pass 2: any due AVIF twin is missing and not tombstoned).
 * provider_metadata is written wholesale from a JS merge — never run this
 * phase concurrently with phase 15 against the same DB.
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

  // Map sha256(file)[0:16] → local path for every image in the WP uploads
  // tree (the same hash Phase 02 stored in files.hash).
  const localByHash = buildLocalHashMap();

  const client = getS3Client();
  const rootPrefix = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
  const urlPrefix = config.s3.baseUrl
    ? config.s3.baseUrl.replace(/\/+$/, "")
    : `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;

  const stats: OptimizeStats = {
    optimized: 0,
    converted: 0,
    variantsUploaded: 0,
    deletedOld: 0,
    skippedNoSource: 0,
    failed: 0,
    avifBackfilled: 0,
    avifVariantsUploaded: 0,
    avifSkippedNoSource: 0,
    avifFailed: 0,
  };

  const limit = pLimit(5);
  const ctx: ProcessContext = {
    client,
    localByHash,
    rootPrefix,
    urlPrefix,
    keepOriginals,
    stats,
  };

  // ── Pass 1: full optimize backfill (formats IS NULL) ────────────────
  if (candidates.length === 0) {
    logger.info("No unoptimized media found — pass 1 has nothing to do");
  } else {
    logger.info(`Found ${candidates.length} unoptimized media files`);
    let processed = 0;
    await Promise.all(
      candidates.map((row) =>
        limit(async () => {
          try {
            await processRow(row, ctx);
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
  }

  // ── Pass 2: add-avif-only backfill (any retryable twin gap) ─────────
  // Note: --keep-originals is a no-op here (pass 2 never deletes objects).
  const avifGap = buildAvifGapWhere(1);
  const avifCandidates = await pgQuery<AvifCandidateRow>(
    `SELECT id, name, hash, ext, mime, width, height, provider_metadata,
            size, formats
     FROM files
     WHERE provider = 'aws-s3'
       AND formats IS NOT NULL
       AND (${avifGap.sql})
       AND mime IN ('image/webp','image/jpeg','image/png')
     ORDER BY id`,
    avifGap.params,
  );

  if (avifCandidates.length === 0) {
    logger.info("No AVIF twin candidates found — pass 2 has nothing to do");
  } else {
    logger.info(`Found ${avifCandidates.length} media files missing AVIF twins`);
    let avifProcessed = 0;
    await Promise.all(
      avifCandidates.map((row) =>
        limit(async () => {
          try {
            await processAvifRow(row, ctx);
          } catch (err: any) {
            stats.avifFailed++;
            logger.error(
              `Failed to backfill AVIF twins for file ${row.id} (${row.name}): ${err.message}`
            );
          } finally {
            avifProcessed++;
            if (avifProcessed % 100 === 0) {
              logger.info(
                `  AVIF backfill progress: ${avifProcessed}/${avifCandidates.length} ` +
                  `(backfilled=${stats.avifBackfilled}, ` +
                  `skipped=${stats.avifSkippedNoSource}, failed=${stats.avifFailed})`
              );
            }
          }
        })
      )
    );
  }

  logger.info(
    `Media optimize complete: optimized=${stats.optimized}, ` +
      `converted→webp=${stats.converted}, variants uploaded=${stats.variantsUploaded}, ` +
      `deleted old objects=${stats.deletedOld}, skipped (no source)=${stats.skippedNoSource}, ` +
      `failed=${stats.failed}, avifBackfilled=${stats.avifBackfilled}, ` +
      `avifVariantsUploaded=${stats.avifVariantsUploaded}, ` +
      `avifSkippedNoSource=${stats.avifSkippedNoSource}, avifFailed=${stats.avifFailed}, ` +
      `avifSkippedLarger=${stats.avifSkippedLarger ?? 0}`
  );
}

interface OptimizeStats {
  optimized: number;
  converted: number;
  variantsUploaded: number;
  deletedOld: number;
  skippedNoSource: number;
  failed: number;
  avifBackfilled: number;
  avifVariantsUploaded: number;
  avifSkippedNoSource: number;
  avifFailed: number;
  /** All twins beaten by their webp counterparts (tiny flat graphics). */
  avifSkippedLarger?: number;
}

interface ProcessContext {
  client: ReturnType<typeof getS3Client>;
  localByHash: Map<string, string>;
  rootPrefix: string;
  urlPrefix: string;
  keepOriginals: boolean;
  stats: OptimizeStats;
}

async function processRow(row: CandidateRow, ctx: ProcessContext): Promise<void> {
  const { client, localByHash, rootPrefix, urlPrefix, keepOriginals, stats } = ctx;

  const meta = parseProviderMetadata(row.provider_metadata);
  const nameNoExt = path.basename(row.name, path.extname(row.name));
  const oldKey: string =
    meta?.key || `${rootPrefix}${row.hash}_${nameNoExt}${row.ext}`;

  // Source bytes: local WP uploads file first, S3 object as fallback.
  let source: Buffer | null = await readLocalByHash(localByHash, row.hash);
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

  // Same SEO folder layout as Phase 02: uploads/{slug}-{hash8}/{slug}{ext},
  // variants alongside in the folder. (This pass previously wrote legacy
  // flat `{hash}_{name}` keys — a leftover from before the folder scheme.)
  const slug = slugifyFileName(nameNoExt);
  const imageFolder = `${slug}-${row.hash.slice(0, 8)}`;
  const newKey = `${rootPrefix}${imageFolder}/${slug}${optimized.ext}`;

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
      hashBase: slug,
      nameBase: slug,
      urlPrefix,
      keyPrefix: `${rootPrefix}${imageFolder}/`,
      avifSource: source,
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

interface AvifCandidateRow {
  id: number;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  width: number | null;
  height: number | null;
  provider_metadata: any;
  /** files.size is KB (legacy /1024 convention in this codebase). */
  size: number | null;
  formats: Record<string, any> | null;
}

/**
 * Pass 2 — add missing AVIF twins to a row that already has formats. Uploads
 * only retryable gaps, then merges the new format entries
 * into the existing formats JSON in a single UPDATE (last step, so a crash
 * leaves the row matching the pass-2 predicate for re-runs). Guard-dropped
 * twins are tombstoned in provider_metadata.avifDropped so the row exits the
 * candidate set instead of re-encoding (and re-dropping) forever.
 */
async function processAvifRow(
  row: AvifCandidateRow,
  ctx: ProcessContext
): Promise<void> {
  const { client, localByHash, rootPrefix, urlPrefix, stats } = ctx;

  const meta = parseProviderMetadata(row.provider_metadata);
  const nameNoExt = path.basename(row.name, path.extname(row.name));
  const s3Key: string =
    meta?.key || `${rootPrefix}${row.hash}_${nameNoExt}${row.ext}`;

  // Source bytes: local WP uploads file first, current S3 object as fallback.
  let source: Buffer | null = await readLocalByHash(localByHash, row.hash);
  if (!source) {
    source = await fetchFromS3(client, s3Key);
  }
  if (!source) {
    stats.avifSkippedNoSource++;
    logger.warn(
      `No source found for AVIF backfill of file ${row.id} (${row.name}, hash=${row.hash}, key=${s3Key})`
    );
    return;
  }

  // nameBase = row.name minus its extension; key/naming conventions follow
  // the row's existing S3 layout (splitS3Key).
  const { keyPrefix, hashBase } = splitS3Key(s3Key, rootPrefix);

  // True dimensions from the source bytes (row.width may not match the
  // source, e.g. a full-resolution local original); fall back to row values
  // when the source cannot be decoded, and skip when neither is available.
  const dims = await decodeOrientedDims(source, row.width, row.height);
  const { width, height } = dims;
  if (!width || !height) {
    stats.avifFailed++;
    logger.warn(
      `Could not determine dimensions for file ${row.id} (${row.name}) — skipping AVIF backfill`
    );
    return;
  }

  const missingKeys = missingAvifTwinKeys(
    row.formats,
    readAvifTombstones(meta),
    width,
    height,
  );
  if (missingKeys.length === 0) return;

  // Size guard inputs: webp counterpart byte sizes from the existing formats
  // entries; the original's bytes from files.size (KB, /1024 convention).
  const compareTo: Record<string, number> = {};
  if (row.size) compareTo.original_avif = Math.round(row.size * 1024);
  for (const key of Object.keys(BREAKPOINTS)) {
    const entry = row.formats?.[key];
    if (entry?.sizeInBytes) compareTo[`${key}_avif`] = entry.sizeInBytes;
  }

  const { formatsJson, uploads, droppedKeys, failedKeys } = await generateAvifTwins(source, {
    width,
    height,
    hashBase,
    nameBase: nameNoExt,
    urlPrefix,
    keyPrefix,
    compareTo,
    onlyKeys: new Set(missingKeys),
  });

  if (uploads.length === 0) {
    if (droppedKeys.length > 0) {
      // WebP already beats AVIF for this image (tiny flat graphics) — not a
      // failure. Tombstone the dropped twins (marker keys inside formats
      // would break Strapi's delete iteration) so the row exits both this
      // pass's predicate and phase 15's generated arms.
      const newMeta = mergeAvifTombstones(meta, droppedKeys);
      if (newMeta) {
        await pgQuery(
          `UPDATE files
           SET provider_metadata = $1::jsonb,
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(newMeta), row.id]
        );
      }
      if (failedKeys.length > 0) {
        // Guard-dropped twins are tombstoned above, but encode failures keep
        // the row eligible — surface them instead of hiding behind the
        // skipped-larger bucket.
        stats.avifFailed++;
        logger.warn(
          `AVIF twin encode(s) failed for file ${row.id} (${row.name}): ` +
            `${failedKeys.join(", ")} — row stays eligible`
        );
      } else {
        stats.avifSkippedLarger = (stats.avifSkippedLarger ?? 0) + 1;
      }
      return;
    }
    // Every target's encode failed — leave the row eligible for re-runs.
    stats.avifFailed++;
    logger.warn(
      `All AVIF twin encodes failed for file ${row.id} (${row.name}) — skipping`
    );
    return;
  }

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

  // Single UPDATE — merge the new avif keys into the existing formats JSON
  // and record any partially-dropped twins in the same write.
  const newMeta = mergeAvifTombstones(meta, droppedKeys);
  if (newMeta) {
    await pgQuery(
      `UPDATE files
       SET formats = (formats::jsonb || $1::jsonb),
           provider_metadata = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(formatsJson), JSON.stringify(newMeta), row.id]
    );
  } else {
    await pgQuery(
      `UPDATE files
       SET formats = (formats::jsonb || $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(formatsJson), row.id]
    );
  }

  if (failedKeys.length > 0) {
    // Partial success persisted above; the failed twins keep the row
    // eligible, so count it as failed rather than backfilled.
    stats.avifFailed++;
    logger.warn(
      `AVIF twin encode(s) failed for file ${row.id} (${row.name}): ` +
        `${failedKeys.join(", ")} — row stays eligible`
    );
  } else {
    stats.avifBackfilled++;
  }
  stats.avifVariantsUploaded += uploads.length;
}

// ── Source resolution helpers (shared with Phase 15) ─────────────────

export function parseProviderMetadata(raw: any): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the local WP uploads file for a content hash — null when the hash is
 * unmapped or the file is unreadable (callers fall back to S3).
 */
export async function readLocalByHash(
  localByHash: Map<string, string>,
  hash: string
): Promise<Buffer | null> {
  const localPath = localByHash.get(hash);
  if (!localPath) return null;
  try {
    return await fs.promises.readFile(localPath);
  } catch {
    return null;
  }
}

export async function fetchFromS3(
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
 * Hashes are cached in .checkpoints/mediaHashMap.json keyed by
 * mtime + size so re-runs don't rehash unchanged files.
 */
export function buildLocalHashMap(): Map<string, string> {
  const map = new Map<string, string>();

  if (!fs.existsSync(config.wpUploadsDir)) {
    logger.warn(
      `WP uploads dir not found at ${config.wpUploadsDir} — will fall back to S3 downloads`
    );
    return map;
  }

  let cache: Record<string, HashCacheEntry> = {};
  const cachePath = fs.existsSync(HASH_MAP_CACHE)
    ? HASH_MAP_CACHE
    : LEGACY_HASH_MAP_CACHE;
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      cache = {};
    }
  }

  let hashed = 0;
  let cached = 0;
  let scanned = 0;
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
        scanned++;
        if (scanned % 5_000 === 0) {
          logger.info(
            `  Local media lookup progress: ${scanned} files scanned ` +
              `(${hashed} hashed, ${cached} cached)`,
          );
        }
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
