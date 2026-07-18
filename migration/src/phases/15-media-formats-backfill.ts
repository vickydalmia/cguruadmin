import fs from "fs";
import path from "path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import sharp from "sharp";
import { pgQuery } from "../db/pg-client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  IMAGE_BREAKPOINTS,
  THUMBNAIL,
  expectedFormatKeys,
  generateStrapiFormats,
  FormatVariantUpload,
} from "../utils/image-optimizer.js";
import { getS3Client } from "./02-media-upload.js";
import {
  CACHE_CONTROL,
  buildLocalHashMap,
  fetchFromS3,
  parseProviderMetadata,
} from "./14-media-optimize.js";

interface BackfillCandidateRow {
  id: number;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  width: number | null;
  height: number | null;
  provider_metadata: any;
  formats: Record<string, any> | null;
}

interface BackfillStats {
  backfilled: number;
  variantsUploaded: number;
  /** Conditional puts answered 412 — the object was already on S3. */
  variantsExisting: number;
  /** Rows whose true-dimension recheck found nothing missing. */
  alreadyComplete: number;
  /** Rows that merged JSON generated for another row sharing the S3 key. */
  reusedShared: number;
  skippedNoSource: number;
  /** Rows whose only missing keys were AVIF twins beaten by their webp
   *  counterpart (or whose twin encodes failed — logged by the generator). */
  skippedLarger: number;
  failed: number;
}

interface BackfillContext {
  client: ReturnType<typeof getS3Client>;
  localByHash: Map<string, string>;
  rootPrefix: string;
  urlPrefix: string;
  overwrite: boolean;
  stats: BackfillStats;
  /** Per-master-key serialization so shared-hash rows never encode concurrently. */
  sharedKeyChains: Map<string, Promise<void>>;
  /** Format entries generated this run, per master key, so shared-hash rows reuse them. */
  sharedKeyEntries: Map<string, Record<string, any>>;
}

// Flipped once when the endpoint rejects IfNoneMatch (NotImplemented on
// non-AWS S3 implementations) — the rest of the run uses unconditional puts.
let conditionalPutSupported = true;

/**
 * Phase 15 — Media Formats Backfill
 *
 * Fills gaps in the responsive-variant matrix for rows that already HAVE
 * formats: Phase 14 pass 1 only handles `formats IS NULL` and pass 2 only
 * adds missing AVIF twins, so the WordPress-era catalog generated before the
 * xsmall(320) rung (or before the thumbnail rung) can never gain those keys
 * from existing tooling. Per row this phase recomputes
 * `expectedFormatKeys() − Object.keys(formats)`, generates ONLY the missing
 * variants from the current S3 master (local WP original as the AVIF source
 * when available), uploads them, and merges the new keys into formats as the
 * LAST step — crash-resumable and idempotent (a re-run finds nothing missing).
 *
 * Flags:
 *   --dry-run    per-row missing-keys report from DB values only; no S3
 *                access, no writes
 *   --limit N    process at most N candidate rows (pilot runs)
 *   --overwrite  regenerate ALL expected keys and replace the S3 objects
 *                (unconditional puts) instead of only filling gaps
 *
 * Variant uploads use PutObject with IfNoneMatch: "*" so re-runs never
 * rewrite bytes already placed (412 counts as success). Masters ≤320 on both
 * axes correctly get nothing; rows whose AVIF twins keep losing the size
 * guard stay perpetual nominal candidates (cheap re-encode + re-drop).
 */
export async function runMediaFormatsBackfill(): Promise<void> {
  logger.info("=== Phase 15: Media Formats Backfill (missing variants) ===");

  const dryRun = process.argv.includes("--dry-run");
  const overwrite = process.argv.includes("--overwrite");
  const limitIdx = process.argv.indexOf("--limit");
  const rawLimit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : NaN;
  const rowLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : null;

  if (dryRun) logger.info("--dry-run: no S3 or database writes will happen");
  if (overwrite) {
    logger.info("--overwrite: ALL expected variants will be regenerated and replaced");
  }
  if (rowLimit) logger.info(`--limit: processing at most ${rowLimit} rows`);

  if (!dryRun && (!config.s3.bucket || !config.s3.accessKeyId)) {
    logger.warn("S3 not configured — skipping media formats backfill");
    return;
  }

  // Coarse SQL pre-filter only (stored width/height may be stale and twin
  // gaps beyond xsmall_avif are not enumerated here) — every selected row is
  // re-verified in JS against the master's true dimensions.
  const params: number[] = [];
  let sql = `SELECT id, name, hash, ext, mime, width, height, provider_metadata, formats
     FROM files
     WHERE provider = 'aws-s3'
       AND formats IS NOT NULL
       AND mime IN ('image/jpeg','image/png','image/webp','image/avif','image/tiff')`;
  if (!overwrite) {
    params.push(IMAGE_BREAKPOINTS.xsmall, THUMBNAIL.width, THUMBNAIL.height);
    sql += `
       AND (
         (NOT (formats::jsonb ? 'xsmall') AND (width > $1 OR height > $1))
         OR (NOT (formats::jsonb ? 'thumbnail') AND (width > $2 OR height > $3))
         OR (mime = 'image/webp' AND NOT (formats::jsonb ? 'xsmall_avif')
             AND (width > $1 OR height > $1))
       )`;
  }
  sql += `
     ORDER BY id`;
  if (rowLimit) {
    params.push(rowLimit);
    sql += ` LIMIT $${params.length}`;
  }

  const candidates = await pgQuery<BackfillCandidateRow>(sql, params);
  if (candidates.length === 0) {
    logger.info("No candidate rows found — variant matrix is complete");
    return;
  }
  logger.info(`Found ${candidates.length} candidate media rows`);

  if (dryRun) {
    let rowsMissing = 0;
    let keysMissing = 0;
    let unknownDims = 0;
    for (const row of candidates) {
      const missing = computeMissingKeys(row, row.width, row.height, overwrite);
      if (!missing) {
        // The real run decodes the S3 master for dimensions; the DB-only
        // dry run cannot, so surface the row instead of dropping it.
        unknownDims++;
        logger.warn(
          `  [dry-run] file ${row.id} (${row.name}): stored dimensions ` +
            `unknown — the real run decides from the S3 master`
        );
        continue;
      }
      if (missing.length === 0) continue;
      rowsMissing++;
      keysMissing += missing.length;
      logger.info(
        `  [dry-run] file ${row.id} (${row.name}, ${row.width}x${row.height}): ` +
          `missing ${missing.join(", ")}`
      );
    }
    logger.info(
      `Dry run complete: ${rowsMissing}/${candidates.length} rows would be ` +
        `backfilled (${keysMissing} format keys` +
        (unknownDims
          ? `; ${unknownDims} rows with unknown stored dimensions decided at run time`
          : "") +
        `)`
    );
    return;
  }

  const localByHash = buildLocalHashMap();
  const client = getS3Client();
  const rootPrefix = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
  const urlPrefix = config.s3.baseUrl
    ? config.s3.baseUrl.replace(/\/+$/, "")
    : `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;

  const stats: BackfillStats = {
    backfilled: 0,
    variantsUploaded: 0,
    variantsExisting: 0,
    alreadyComplete: 0,
    reusedShared: 0,
    skippedNoSource: 0,
    skippedLarger: 0,
    failed: 0,
  };

  const ctx: BackfillContext = {
    client,
    localByHash,
    rootPrefix,
    urlPrefix,
    overwrite,
    stats,
    sharedKeyChains: new Map(),
    sharedKeyEntries: new Map(),
  };

  const limit = pLimit(5);
  let processed = 0;
  await Promise.all(
    candidates.map((row) =>
      limit(async () => {
        try {
          await processFormatsRow(row, ctx);
        } catch (err: any) {
          stats.failed++;
          logger.error(
            `Failed to backfill formats for file ${row.id} (${row.name}): ${err.message}`
          );
        } finally {
          processed++;
          if (processed % 100 === 0) {
            logger.info(
              `  Formats backfill progress: ${processed}/${candidates.length} ` +
                `(backfilled=${stats.backfilled}, complete=${stats.alreadyComplete}, ` +
                `skipped=${stats.skippedNoSource}, failed=${stats.failed})`
            );
          }
        }
      })
    )
  );

  logger.info(
    `Media formats backfill complete: backfilled=${stats.backfilled}, ` +
      `variants uploaded=${stats.variantsUploaded}, already on S3=${stats.variantsExisting}, ` +
      `already complete=${stats.alreadyComplete}, reused shared=${stats.reusedShared}, ` +
      `skipped (no source)=${stats.skippedNoSource}, ` +
      `skipped (avif larger)=${stats.skippedLarger}, failed=${stats.failed}`
  );
}

/**
 * Expected-minus-stored format keys for a row (null when dimensions are
 * unknown). --overwrite returns every expected key regardless of storage.
 */
function computeMissingKeys(
  row: BackfillCandidateRow,
  width: number | null,
  height: number | null,
  overwrite: boolean
): string[] | null {
  if (!width || !height) return null;
  const expected = expectedFormatKeys(width, height, row.mime);
  if (overwrite) return expected;
  const stored = new Set(Object.keys(row.formats ?? {}));
  return expected.filter((key) => !stored.has(key));
}

async function processFormatsRow(
  row: BackfillCandidateRow,
  ctx: BackfillContext
): Promise<void> {
  const { stats, sharedKeyChains } = ctx;

  const meta = parseProviderMetadata(row.provider_metadata);
  const nameNoExt = path.basename(row.name, path.extname(row.name));
  // Migration rows always carry provider_metadata.key (phase 02 writes it);
  // rows the aws-s3 provider created carry none, and its convention is
  // rootPath/{hash}{ext} — the upload extension's hash embeds the per-image
  // folder. The migration-era flat {hash}_{name}{ext} form stays as a second
  // fetch attempt for pre-folder-scheme rows.
  const s3KeyCandidates: string[] = meta?.key
    ? [meta.key]
    : [
        `${ctx.rootPrefix}${row.hash}${row.ext}`,
        `${ctx.rootPrefix}${row.hash}_${nameNoExt}${row.ext}`,
      ];
  // Rows sharing a hash share the same candidate list, so the first candidate
  // is a stable serialization/cache key even before the fetch resolves.
  const s3Key = s3KeyCandidates[0];

  // Rows sharing an S3 key (same content hash) serialize behind one another
  // so variants encode/upload once (later rows reuse sharedKeyEntries), but
  // every row computes and merges its OWN missing set: phase checkpointing
  // means a row handed another row's subset would stay incomplete until an
  // operator explicitly re-ran the phase.
  const prevChain = sharedKeyChains.get(s3Key);
  const task = (prevChain ?? Promise.resolve()).then(() =>
    generateMissingForRow(row, s3KeyCandidates, nameNoExt, ctx)
  );
  // A failed row must not block waiting shared rows; this row's caller still
  // sees the rejection through `await task` below.
  sharedKeyChains.set(
    s3Key,
    task.then(
      () => undefined,
      () => undefined
    )
  );

  const formatsJson = await task;
  if (!formatsJson || Object.keys(formatsJson).length === 0) return;

  // Single UPDATE merging the new keys — the LAST step, so a crash earlier
  // leaves the row a candidate for re-runs.
  await mergeFormats(row.id, formatsJson);
  if (prevChain) stats.reusedShared++;
  else stats.backfilled++;
}

/**
 * Generate + upload the row's missing variants; returns the formats JSON to
 * merge (null when there is nothing to merge — stats already updated).
 */
async function generateMissingForRow(
  row: BackfillCandidateRow,
  keyCandidates: readonly string[],
  nameNoExt: string,
  ctx: BackfillContext
): Promise<Record<string, any> | null> {
  const { client, localByHash, stats } = ctx;
  const cacheKey = keyCandidates[0];

  // The stored formats derive from the S3 master, so it is both the resize
  // source and the authority on dimensions. Candidate keys are tried in
  // order; the one that hits defines where the new variants land.
  let master: Buffer | null = null;
  let s3Key = cacheKey;
  for (const key of keyCandidates) {
    master = await fetchFromS3(client, key);
    if (master) {
      s3Key = key;
      break;
    }
  }
  if (!master) {
    stats.skippedNoSource++;
    logger.warn(
      `No S3 master for file ${row.id} (${row.name}, hash=${row.hash}, ` +
        `tried: ${keyCandidates.join(", ")})`
    );
    return null;
  }

  // True master dimensions (EXIF orientation 5-8 swaps width/height); the
  // stored row values are only a fallback for undecodable bytes.
  let width: number | null = null;
  let height: number | null = null;
  try {
    const srcMeta = await sharp(master).metadata();
    const swapped = (srcMeta.orientation ?? 1) >= 5;
    width = (swapped ? srcMeta.height : srcMeta.width) ?? null;
    height = (swapped ? srcMeta.width : srcMeta.height) ?? null;
  } catch {
    width = null;
    height = null;
  }
  if (!width || !height) {
    width = row.width;
    height = row.height;
  }
  if (!width || !height) {
    stats.failed++;
    logger.warn(
      `Could not determine dimensions for file ${row.id} (${row.name}) — skipping`
    );
    return null;
  }

  const missing = computeMissingKeys(row, width, height, ctx.overwrite) ?? [];
  if (missing.length === 0) {
    // The SQL pre-filter matched on stale stored dimensions.
    stats.alreadyComplete++;
    return null;
  }

  // Entries an earlier shared-hash row already generated+uploaded this run
  // satisfy this row without re-encoding; only the remainder is generated.
  const cachedEntries = ctx.sharedKeyEntries.get(cacheKey) ?? {};
  const toGenerate = missing.filter((key) => !(key in cachedEntries));
  if (toGenerate.length === 0) {
    return pickEntries(cachedEntries, missing);
  }

  // Key/naming conventions follow the row's existing S3 layout (same
  // derivation as Phase 14 pass 2), so new variants land beside the old ones
  // for both folder-scheme and legacy flat keys.
  const lastSlash = s3Key.lastIndexOf("/");
  const keyPrefix = lastSlash >= 0 ? s3Key.slice(0, lastSlash + 1) : ctx.rootPrefix;
  const keyBasename = lastSlash >= 0 ? s3Key.slice(lastSlash + 1) : s3Key;
  const hashBase = path.basename(keyBasename, path.extname(keyBasename));

  // AVIF twins encode from the pre-optimization WP original when available
  // (highest-quality input); webp tiers always resize the S3 master.
  let avifSource: Buffer | undefined;
  const localPath = localByHash.get(row.hash);
  if (localPath) {
    try {
      avifSource = fs.readFileSync(localPath);
    } catch {
      avifSource = undefined;
    }
  }

  // Byte sizes of the already-uploaded webp tiers for the AVIF size guard
  // (tiers skipped via onlyKeys have no in-run counterpart). Entries carry
  // sizeInBytes; `size` is KB via /1000, so *1000 restores bytes.
  const existingSizes: Record<string, number> = {};
  for (const [key, entry] of Object.entries(row.formats ?? {})) {
    const bytes =
      entry?.sizeInBytes ??
      (typeof entry?.size === "number" ? Math.round(entry.size * 1000) : undefined);
    if (bytes) existingSizes[key] = bytes;
  }

  const { formatsJson, uploads } = await generateStrapiFormats(master, {
    width,
    height,
    ext: row.ext,
    mime: row.mime,
    hashBase,
    nameBase: nameNoExt,
    urlPrefix: ctx.urlPrefix,
    keyPrefix,
    avifSource,
    onlyKeys: new Set(toGenerate),
    existingSizes,
  });

  const merged = { ...pickEntries(cachedEntries, missing), ...formatsJson };
  if (Object.keys(merged).length === 0) {
    // Only AVIF twins were due and every one lost the size guard (or its
    // encode failed — already logged): nothing to upload or merge. The row
    // stays a nominal candidate, exactly like Phase 14 pass 2.
    stats.skippedLarger++;
    return null;
  }

  for (const variant of uploads) {
    const outcome = await putVariant(ctx, variant);
    if (outcome === "existing") stats.variantsExisting++;
    else stats.variantsUploaded++;
  }
  ctx.sharedKeyEntries.set(cacheKey, { ...cachedEntries, ...formatsJson });

  return merged;
}

/** Subset of `entries` limited to `keys` (missing entries are skipped). */
function pickEntries(
  entries: Record<string, any>,
  keys: readonly string[]
): Record<string, any> {
  const picked: Record<string, any> = {};
  for (const key of keys) {
    if (key in entries) picked[key] = entries[key];
  }
  return picked;
}

/**
 * Upload one variant. Without --overwrite the put is conditional
 * (IfNoneMatch: "*"): 412 means a previous run already placed the object and
 * counts as success; NotImplemented endpoints flip to unconditional puts for
 * the rest of the run.
 */
async function putVariant(
  ctx: BackfillContext,
  variant: FormatVariantUpload
): Promise<"uploaded" | "existing"> {
  const params = {
    Bucket: config.s3.bucket,
    Key: variant.key,
    Body: variant.buffer,
    ContentType: variant.contentType,
    CacheControl: CACHE_CONTROL,
  };

  if (ctx.overwrite || !conditionalPutSupported) {
    await ctx.client.send(new PutObjectCommand(params));
    return "uploaded";
  }

  try {
    await ctx.client.send(new PutObjectCommand({ ...params, IfNoneMatch: "*" }));
    return "uploaded";
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (err?.name === "PreconditionFailed" || status === 412) {
      return "existing";
    }
    if (err?.name === "NotImplemented" || status === 501) {
      conditionalPutSupported = false;
      logger.warn(
        "S3 endpoint does not implement IfNoneMatch — falling back to unconditional PutObject"
      );
      await ctx.client.send(new PutObjectCommand(params));
      return "uploaded";
    }
    throw err;
  }
}

async function mergeFormats(
  fileId: number,
  formatsJson: Record<string, any>
): Promise<void> {
  await pgQuery(
    `UPDATE files
     SET formats = (formats::jsonb || $1::jsonb),
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(formatsJson), fileId]
  );
}
