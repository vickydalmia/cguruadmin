import { PutObjectCommand } from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import { pgQuery } from "../db/pg-client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  decodeOrientedDims,
  expectedFormatKeys,
  generateStrapiFormats,
  splitS3Key,
  FormatVariantUpload,
} from "../utils/image-optimizer.js";
import {
  AVIF_DROPPED_META_KEY,
  buildGapWhere,
  mergeAvifTombstones,
  readAvifTombstones,
} from "../utils/format-gaps.js";
import { parseLimitFlag } from "../utils/cli.js";
import { mediaSourceResolution } from "../utils/media-source-candidates.js";
import { getS3Client } from "./02-media-upload.js";
import {
  CACHE_CONTROL,
  buildLocalHashMap,
  fetchFromS3,
  parseProviderMetadata,
  readLocalByHash,
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
  /** Rows satisfied entirely by entries a groupmate generated this run. */
  reusedShared: number;
  /** Rows whose NULL stored width/height were filled from the decoded master. */
  dimsBackfilled: number;
  skippedNoSource: number;
  /** Rows whose only persisted outcome was tombstoning guard-dropped twins. */
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
}

/** Rows sharing one complete source-candidate list — decoded and encoded once. */
interface KeyGroup {
  cacheKey: string;
  keyCandidates: string[];
  nameNoExt: string;
  rows: BackfillCandidateRow[];
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
 * from existing tooling. Candidates come from a WHERE clause GENERATED off
 * the same constants expectedFormatKeys uses (buildGapWhere): one arm per
 * thumbnail/breakpoint gap, tombstone-guarded arms per AVIF twin, and a
 * `width IS NULL OR height IS NULL` arm — NULL dims silence every comparison
 * arm, so those rows are selected and their true dims persisted from the
 * decoded master (including when nothing else is missing). Per row this
 * phase recomputes expected − stored − tombstoned keys, generates ONLY the
 * missing variants from the current S3 master (local WP original as the AVIF
 * source when available), uploads them, and merges the new keys in ONE
 * per-row UPDATE as the LAST step — crash-resumable and idempotent.
 *
 * Convergence: AVIF twins the size guard drops are recorded in
 * provider_metadata.avifDropped (same UPDATE) and excluded from selection,
 * so a re-run after a successful pass selects ~0 rows and fetches ~0
 * masters. Rows sharing one S3 master form a group: the master is fetched
 * and dim-decoded once, generated entries and dropped keys are shared, and
 * each row still merges its OWN missing set. provider_metadata is written
 * wholesale from a JS merge — never run this phase concurrently with 14.
 *
 * Flags:
 *   --dry-run    per-row missing-keys report from DB values only; no S3
 *                access, no writes
 *   --limit N    process at most N candidate rows (pilot runs); malformed
 *                values abort before any DB/S3 access
 *   --overwrite  regenerate ALL expected keys, replace the S3 objects
 *                (unconditional puts), and REPLACE avifDropped with this
 *                run's actual drops — the escape hatch when encoder tuning
 *                makes previously-dropped twins viable
 *
 * Variant uploads use PutObject with IfNoneMatch: "*" so re-runs never
 * rewrite bytes already placed (412 counts as success). Masters ≤320 on both
 * axes correctly get nothing.
 */
export async function runMediaFormatsBackfill(): Promise<void> {
  logger.info("=== Phase 15: Media Formats Backfill (missing variants) ===");

  const dryRun = process.argv.includes("--dry-run");
  const overwrite = process.argv.includes("--overwrite");
  const limitFlag = parseLimitFlag(process.argv);
  if (limitFlag.kind === "invalid") {
    // Abort before any DB/S3 access: a lenient parse here once meant a typo
    // ran the whole catalog instead of a pilot.
    logger.error(limitFlag.reason);
    process.exit(1);
  }
  const rowLimit = limitFlag.kind === "valid" ? limitFlag.value : null;

  if (dryRun) logger.info("--dry-run: no S3 or database writes will happen");
  if (overwrite) {
    logger.info("--overwrite: ALL expected variants will be regenerated and replaced");
  }
  if (rowLimit) logger.info(`--limit: processing at most ${rowLimit} rows`);

  if (!dryRun && (!config.s3.bucket || !config.s3.accessKeyId)) {
    logger.warn("S3 not configured — skipping media formats backfill");
    return;
  }

  // Selection is authoritative-but-coarse (stored width/height may be stale):
  // every selected row is re-verified in JS against the master's true
  // dimensions before anything is generated.
  const params: number[] = [];
  let sql = `SELECT id, name, hash, ext, mime, width, height, provider_metadata, formats
     FROM files
     WHERE provider = 'aws-s3'
       AND formats IS NOT NULL
       AND mime IN ('image/jpeg','image/png','image/webp','image/avif','image/tiff')`;
  if (!overwrite) {
    const gap = buildGapWhere(params.length + 1);
    params.push(...gap.params);
    sql += `
       AND (${gap.sql})`;
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
      const tombstoned = readAvifTombstones(
        parseProviderMetadata(row.provider_metadata)
      );
      const missing = computeMissingKeys(
        row,
        row.width,
        row.height,
        overwrite,
        tombstoned
      );
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
    dimsBackfilled: 0,
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
  };

  const groups = groupByPrimaryKey(candidates, rootPrefix);
  const limit = pLimit(5);
  let processedRows = 0;
  await Promise.all(
    groups.map((group) =>
      limit(async () => {
        try {
          await processKeyGroup(group, ctx);
        } catch (err: any) {
          stats.failed += group.rows.length;
          logger.error(
            `Failed to backfill formats group ${group.cacheKey}: ${err.message}`
          );
        } finally {
          const before = processedRows;
          processedRows += group.rows.length;
          if (Math.floor(processedRows / 100) > Math.floor(before / 100)) {
            logger.info(
              `  Formats backfill progress: ${processedRows}/${candidates.length} rows ` +
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
      `dims backfilled=${stats.dimsBackfilled}, ` +
      `skipped (no source)=${stats.skippedNoSource}, ` +
      `skipped (avif larger)=${stats.skippedLarger}, failed=${stats.failed}`
  );
}

/**
 * Expected-minus-stored-minus-tombstoned format keys for a row (null when
 * dimensions are unknown). --overwrite returns every expected key regardless
 * of storage or tombstones.
 */
function computeMissingKeys(
  row: BackfillCandidateRow,
  width: number | null,
  height: number | null,
  overwrite: boolean,
  tombstoned: ReadonlySet<string>
): string[] | null {
  if (!width || !height) return null;
  const expected = expectedFormatKeys(width, height, row.mime);
  if (overwrite) return expected;
  const stored = new Set(Object.keys(row.formats ?? {}));
  return expected.filter((key) => !stored.has(key) && !tombstoned.has(key));
}

/**
 * Group candidate rows by their complete ordered source-candidate list
 * (zero I/O — derivable from the row alone), preserving id order within and
 * across groups.
 */
function groupByPrimaryKey(
  rows: readonly BackfillCandidateRow[],
  rootPrefix: string
): KeyGroup[] {
  const groups = new Map<string, KeyGroup>();
  for (const row of rows) {
    const meta = parseProviderMetadata(row.provider_metadata);
    // Migration rows always carry provider_metadata.key (phase 02 writes it);
    // rows the aws-s3 provider created carry none, and its convention is
    // rootPath/{hash}{ext} — the upload extension's hash embeds the per-image
    // folder. The migration-era flat {hash}_{name}{ext} form stays as a
    // second fetch attempt for pre-folder-scheme rows. CANDIDATE ORDER IS
    // INTENTIONAL: provider-shaped first, legacy flat second.
    // Group by the COMPLETE ordered candidate list. The provider-shaped key
    // can be shared by metadata-less rows whose legacy fallback differs by
    // name; grouping those rows before resolution would discard every
    // fallback except the first row's.
    const { groupKey, keyCandidates, nameNoExt } = mediaSourceResolution(
      row,
      rootPrefix,
      typeof meta?.key === "string" ? meta.key : null,
    );
    const cacheKey = keyCandidates[0];
    let group = groups.get(groupKey);
    if (!group) {
      group = { cacheKey, keyCandidates, nameNoExt, rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/**
 * Process every row of one shared-master group sequentially: the master is
 * fetched and dim-decoded once, the local WP original is read at most once
 * (lazily, only when a webp row has a twin to generate), and entries/dropped
 * keys generated for one row satisfy groupmates without re-encoding. Every
 * row still computes and persists its OWN missing set — a row handed another
 * row's subset would stay incomplete until an operator re-ran the phase.
 */
async function processKeyGroup(
  group: KeyGroup,
  ctx: BackfillContext
): Promise<void> {
  const { client, stats } = ctx;

  // The stored formats derive from the S3 master, so it is both the resize
  // source and the authority on dimensions. Candidate keys are tried in
  // order; the one that hits defines where the new variants land.
  let master: Buffer | null = null;
  let resolvedKey = group.cacheKey;
  for (const key of group.keyCandidates) {
    master = await fetchFromS3(client, key);
    if (master) {
      resolvedKey = key;
      break;
    }
  }
  if (!master) {
    stats.skippedNoSource += group.rows.length;
    logger.warn(
      `No S3 master for ${group.rows.length} row(s), first file ` +
        `${group.rows[0].id} (${group.rows[0].name}, hash=${group.rows[0].hash}, ` +
        `tried: ${group.keyCandidates.join(", ")})`
    );
    return;
  }

  const dims = await decodeOrientedDims(master, null, null);
  const { keyPrefix, hashBase } = splitS3Key(resolvedKey, ctx.rootPrefix);

  // AVIF twins encode from the pre-optimization WP original when available
  // (highest-quality input); read lazily, at most once per distinct hash —
  // rows grouped by one S3 key normally share a hash, but nothing enforces
  // it, and a groupmate must never encode from another row's original.
  const localPromises = new Map<string, Promise<Buffer | null>>();
  const getAvifSource = (hash: string): Promise<Buffer | null> => {
    let promise = localPromises.get(hash);
    if (!promise) {
      promise = readLocalByHash(ctx.localByHash, hash);
      localPromises.set(hash, promise);
    }
    return promise;
  };

  // Group-shared outcomes: entries generated for one row satisfy groupmates;
  // dropped twin keys propagate so groupmates don't re-attempt them.
  const entries: Record<string, any> = {};
  const droppedSet = new Set<string>();

  for (const row of group.rows) {
    // A failed row must not block groupmates (the old per-key chain had the
    // same guarantee).
    try {
      const effWidth = dims.width ?? row.width;
      const effHeight = dims.height ?? row.height;
      if (!effWidth || !effHeight) {
        stats.failed++;
        logger.warn(
          `Could not determine dimensions for file ${row.id} (${row.name}) — skipping`
        );
        continue;
      }

      const meta = parseProviderMetadata(row.provider_metadata);
      const tombstoned = readAvifTombstones(meta);
      const missing =
        computeMissingKeys(row, effWidth, effHeight, ctx.overwrite, tombstoned) ?? [];
      const needsDims =
        dims.decoded && (row.width == null || row.height == null);

      if (missing.length === 0) {
        // The SQL arms matched on stale (or NULL) stored values.
        stats.alreadyComplete++;
        if (needsDims) {
          // NULL-dims rows must exit the selector's NULL arm even when
          // nothing is missing, or they get re-fetched forever.
          await persistRow(row.id, { width: dims.width!, height: dims.height! });
          stats.dimsBackfilled++;
        }
        continue;
      }

      const toGenerate = missing.filter(
        (key) => !(key in entries) && !droppedSet.has(key)
      );
      let generatedOwn = false;
      if (toGenerate.length > 0) {
        // Byte sizes of the already-uploaded webp tiers for the AVIF size
        // guard (tiers skipped via onlyKeys have no in-run counterpart).
        // Entries carry sizeInBytes; `size` is KB via /1000, so *1000
        // restores bytes.
        const existingSizes: Record<string, number> = {};
        for (const [key, entry] of Object.entries(row.formats ?? {})) {
          const bytes =
            entry?.sizeInBytes ??
            (typeof entry?.size === "number"
              ? Math.round(entry.size * 1000)
              : undefined);
          if (bytes) existingSizes[key] = bytes;
        }

        const wantsTwin =
          row.mime === "image/webp" &&
          toGenerate.some((key) => key.endsWith("_avif"));
        const avifSource = wantsTwin
          ? (await getAvifSource(row.hash)) ?? undefined
          : undefined;

        const { formatsJson, uploads, droppedAvifKeys } =
          await generateStrapiFormats(master, {
            width: effWidth,
            height: effHeight,
            ext: row.ext,
            mime: row.mime,
            hashBase,
            nameBase: group.nameNoExt,
            urlPrefix: ctx.urlPrefix,
            keyPrefix,
            avifSource,
            onlyKeys: new Set(toGenerate),
            existingSizes,
          });

        for (const variant of uploads) {
          const outcome = await putVariant(ctx, variant);
          if (outcome === "existing") stats.variantsExisting++;
          else stats.variantsUploaded++;
        }
        Object.assign(entries, formatsJson);
        for (const key of droppedAvifKeys) droppedSet.add(key);
        generatedOwn = Object.keys(formatsJson).length > 0;
      }

      const merged = pickEntries(entries, missing);
      const rowDropped = missing.filter((key) => droppedSet.has(key));

      if (Object.keys(merged).length === 0 && rowDropped.length === 0) {
        // Every due encode failed (already logged by the generator) — leave
        // the row untouched so it stays eligible for re-runs.
        stats.failed++;
        continue;
      }

      const metaPatch = ctx.overwrite
        ? replaceAvifTombstones(meta, rowDropped)
        : mergeAvifTombstones(meta, rowDropped);

      const patch: RowPatch = {};
      if (Object.keys(merged).length > 0) patch.formats = merged;
      if (metaPatch) patch.providerMetadata = metaPatch;
      if (needsDims) {
        patch.width = dims.width!;
        patch.height = dims.height!;
      }
      await persistRow(row.id, patch);

      if (needsDims) stats.dimsBackfilled++;
      // Keys neither generated nor guard-dropped are encode failures: the
      // row stays eligible for them, and the failure must not hide behind a
      // success bucket even though the partial results were persisted.
      const unresolved = missing.filter(
        (key) => !(key in merged) && !rowDropped.includes(key)
      );
      if (unresolved.length > 0) {
        stats.failed++;
        logger.warn(
          `File ${row.id} (${row.name}): ${unresolved.length} variant ` +
            `encode(s) failed (${unresolved.join(", ")}) — row stays eligible`
        );
      } else if (Object.keys(merged).length > 0) {
        if (generatedOwn) stats.backfilled++;
        else stats.reusedShared++;
      } else {
        stats.skippedLarger++;
      }
    } catch (err: any) {
      stats.failed++;
      logger.error(
        `Failed to backfill formats for file ${row.id} (${row.name}): ${err.message}`
      );
    }
  }
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
 * --overwrite REPLACES the tombstone list with this run's actual drops (a
 * regenerated twin must clear its stale tombstone); null when unchanged.
 */
function replaceAvifTombstones(
  meta: Record<string, any> | null,
  dropped: readonly string[]
): Record<string, any> | null {
  const next = [...new Set(dropped)].sort();
  const prev = [...readAvifTombstones(meta)].sort();
  if (next.length === prev.length && next.every((key, i) => key === prev[i])) {
    return null;
  }
  const copy = { ...(meta ?? {}) };
  if (next.length > 0) copy[AVIF_DROPPED_META_KEY] = next;
  else delete copy[AVIF_DROPPED_META_KEY];
  return copy;
}

interface RowPatch {
  formats?: Record<string, any>;
  providerMetadata?: Record<string, any>;
  width?: number;
  height?: number;
}

/**
 * ONE dynamic UPDATE per row — always the LAST step, so a crash earlier
 * leaves the row a candidate for re-runs. formats keys MERGE (`||` keeps
 * keys the patch doesn't mention); provider_metadata is replaced wholesale
 * from the JS merge (single-writer assumption — see the phase doc comment).
 */
async function persistRow(rowId: number, patch: RowPatch): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [];
  if (patch.formats) {
    values.push(JSON.stringify(patch.formats));
    sets.push(`formats = (formats::jsonb || $${values.length}::jsonb)`);
  }
  if (patch.providerMetadata) {
    values.push(JSON.stringify(patch.providerMetadata));
    sets.push(`provider_metadata = $${values.length}::jsonb`);
  }
  if (patch.width != null && patch.height != null) {
    values.push(patch.width);
    sets.push(`width = $${values.length}`);
    values.push(patch.height);
    sets.push(`height = $${values.length}`);
  }
  if (sets.length === 0) return;
  values.push(rowId);
  await pgQuery(
    `UPDATE files
     SET ${sets.join(",\n         ")},
         updated_at = NOW()
     WHERE id = $${values.length}`,
    values
  );
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
