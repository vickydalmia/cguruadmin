import {
  formatTargets,
  splitS3Key,
  IMAGE_OPTIMIZATION,
} from "./image-optimizer.js";
import { mediaSourceResolution } from "./media-source-candidates.js";

// Config-free on purpose (the format-gaps.ts precedent): the tsx test suite
// imports this module directly, and config.ts throws without .env.migration.
// All IO (files table, S3, checkpoint files) lives in file-manifest.ts.

export interface ManifestBackgroundRemoval {
  sourceHash: string;
  version: string;
  removedAt: string;
}

/**
 * Everything needed to re-create a `files` row WITHOUT touching the image
 * bytes, keyed by `files.hash` (sha256(source bytes)[0:16]). `s3Keys` is the
 * complete set of objects the row references (master + variants + AVIF twins);
 * reuse requires every one of them to still exist. `masterKeys` handles
 * legacy flat-scheme rows where the exact master key is ambiguous — any one
 * present satisfies the master requirement.
 */
export interface FileManifestEntry {
  name: string;
  alternativeText: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  /** Verbatim files.formats jsonb (null for non-optimized files). */
  formats: Record<string, any> | null;
  ext: string;
  mime: string;
  /** files.size — kilobytes, the pipeline's `bytes / 1024` convention. */
  sizeKb: number;
  url: string;
  /** Verbatim provider_metadata — includes `key` and any avifDropped list. */
  providerMetadata: Record<string, any>;
  backgroundColour: string | null;
  backgroundRemoval: ManifestBackgroundRemoval | null;
  /** Master key candidates (exactly one for folder-scheme rows). */
  masterKeys: string[];
  /** Every non-master object key referenced by `formats`. */
  s3Keys: string[];
  syncedAt: string;
}

export interface FileManifest {
  version: 1;
  /** Base URL entries were built against (S3_BASE_URL without trailing '/'). */
  urlPrefix: string;
  entries: Record<string, FileManifestEntry>;
}

export function emptyFileManifest(urlPrefix: string): FileManifest {
  return { version: 1, urlPrefix, entries: {} };
}

/** Loose shape of a `files` row as selected by file-manifest.ts / rebuild. */
export interface FilesRowLike {
  name: string;
  alternative_text?: string | null;
  caption?: string | null;
  width: number | null;
  height: number | null;
  formats: unknown;
  ext: string;
  mime: string;
  size: number | string;
  hash: string;
  url: string;
  provider: string;
  provider_metadata: unknown;
  background_colour?: string | null;
  background_removal_source_hash?: string | null;
  background_removal_version?: string | null;
  background_removed_at?: string | Date | null;
}

export function parseJsonish(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? (value as Record<string, any>) : null;
}

function formatEntryKey(
  entry: Record<string, any>,
  urlPrefix: string,
  masterKeyPrefix: string,
): string | null {
  const url = typeof entry?.url === "string" ? entry.url : null;
  if (url && urlPrefix && url.startsWith(`${urlPrefix}/`)) {
    return url.slice(urlPrefix.length + 1);
  }
  // Fallback: variants always land beside the master, named hash + ext.
  if (typeof entry?.hash === "string" && typeof entry?.ext === "string") {
    return `${masterKeyPrefix}${entry.hash}${entry.ext}`;
  }
  return null;
}

function masterKeyCandidates(
  row: FilesRowLike,
  rootPrefix: string,
): string[] {
  const metadata = parseJsonish(row.provider_metadata);
  const explicit = metadata?.key;
  if (typeof explicit === "string" && explicit.length > 0) return [explicit];
  return mediaSourceResolution(
    { name: row.name, hash: row.hash, ext: row.ext },
    rootPrefix,
  ).keyCandidates;
}

/**
 * Build a manifest entry from an aws-s3 `files` row. Returns null for other
 * providers (nothing to reuse) and for rows whose master key cannot be
 * derived at all.
 */
export function manifestEntryFromRow(
  row: FilesRowLike,
  urlPrefix: string,
  rootPrefix: string,
  syncedAt: string,
): FileManifestEntry | null {
  if (row.provider !== "aws-s3") return null;
  const masters = masterKeyCandidates(row, rootPrefix);
  if (masters.length === 0) return null;

  const formats = parseJsonish(row.formats);
  const { keyPrefix } = splitS3Key(masters[0], rootPrefix);
  const variantKeys: string[] = [];
  for (const entry of Object.values(formats ?? {})) {
    const key = formatEntryKey(entry as Record<string, any>, urlPrefix, keyPrefix);
    // A formats entry whose key cannot be derived would make the reuse check
    // vacuous — treat the whole row as non-reusable instead.
    if (!key) return null;
    variantKeys.push(key);
  }

  const removedAt = row.background_removed_at;
  const backgroundRemoval: ManifestBackgroundRemoval | null =
    row.background_removal_source_hash && row.background_removal_version
      ? {
          sourceHash: row.background_removal_source_hash,
          version: row.background_removal_version,
          removedAt:
            removedAt instanceof Date
              ? removedAt.toISOString()
              : (removedAt ?? syncedAt),
        }
      : null;

  return {
    name: row.name,
    alternativeText: row.alternative_text ?? null,
    caption: row.caption ?? null,
    width: row.width,
    height: row.height,
    formats,
    ext: row.ext,
    mime: row.mime,
    sizeKb: typeof row.size === "string" ? parseFloat(row.size) : row.size,
    url: row.url,
    providerMetadata: parseJsonish(row.provider_metadata) ?? {},
    backgroundColour: row.background_colour ?? null,
    backgroundRemoval,
    masterKeys: masters,
    s3Keys: variantKeys,
    syncedAt,
  };
}

/**
 * Every S3 key a `files` row can be serving, for orphan cleanup. Shares the
 * derivation with manifestEntryFromRow so cleanup and reuse can never
 * disagree. Conservative for legacy rows: returns ALL master candidates.
 * Underivable formats entries contribute nothing (the caller's safety guards
 * handle pathological rows).
 */
export function referencedKeysFromRow(
  row: FilesRowLike,
  urlPrefix: string,
  rootPrefix: string,
): string[] {
  if (row.provider !== "aws-s3") return [];
  const masters = masterKeyCandidates(row, rootPrefix);
  const keys = new Set<string>(masters);
  const formats = parseJsonish(row.formats);
  const keyPrefix = masters.length > 0
    ? splitS3Key(masters[0], rootPrefix).keyPrefix
    : rootPrefix;
  for (const entry of Object.values(formats ?? {})) {
    const key = formatEntryKey(entry as Record<string, any>, urlPrefix, keyPrefix);
    if (key) keys.add(key);
  }
  return [...keys];
}

export type MediaReuseDecision =
  | { action: "db-skip" }
  | { action: "manifest-reuse"; entry: FileManifestEntry }
  | { action: "process"; missingKeys?: string[] };

/**
 * The reuse decision for one content hash. DB rows stay authoritative
 * (availability of their master is checked separately by the caller, as
 * today); the manifest only fills the fresh-database gap, and only when the
 * bucket still holds EVERY object the recreated row would reference.
 */
export function decideMediaReuse(args: {
  dbFileId?: number | undefined;
  manifestEntry?: FileManifestEntry | undefined;
  s3KeyIndex: ReadonlySet<string>;
}): MediaReuseDecision {
  if (args.dbFileId !== undefined) return { action: "db-skip" };
  const entry = args.manifestEntry;
  if (!entry) return { action: "process" };

  const missingKeys: string[] = [];
  if (!entry.masterKeys.some((key) => args.s3KeyIndex.has(key))) {
    missingKeys.push(entry.masterKeys[0] ?? "(no master key)");
  }
  for (const key of entry.s3Keys) {
    if (!args.s3KeyIndex.has(key)) missingKeys.push(key);
  }
  if (missingKeys.length > 0) return { action: "process", missingKeys };
  return { action: "manifest-reuse", entry };
}

// ---------------------------------------------------------------------------
// Rebuild-mode formats reconstruction (manifest:rebuild)
// ---------------------------------------------------------------------------

/** Extensions optimizeOriginal would have re-encoded (formats generated). */
const OPTIMIZED_MASTER_EXTS = new Set([".webp", ".avif", ".tif", ".tiff"]);

export interface ReconstructInput {
  /** Oriented dimensions of the LOCAL source file. */
  sourceWidth: number;
  sourceHeight: number;
  /** Master object actually present in the bucket. */
  masterKey: string;
  masterExt: string;
  masterMime: string;
  masterSizeBytes: number;
  slug: string;
  /** Key prefix including trailing slash (the image's folder). */
  keyPrefix: string;
  urlPrefix: string;
  /** Byte size per key for every object in the image's folder. */
  sizesByKey: ReadonlyMap<string, number>;
  maxDimension?: number;
}

export interface ReconstructResult {
  formatsJson: Record<string, any> | null;
  width: number;
  height: number;
  s3Keys: string[];
  /** Non-empty ⇒ the hash must NOT enter the manifest (reprocess normally). */
  ambiguous: string[];
}

/** sharp fit:"inside" — scale to fit the box, preserve aspect, round. */
export function fitInside(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(boxWidth / width, boxHeight / height, 1);
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Rebuild the formats jsonb a phase-02 upload would have produced, without
 * decoding or encoding anything: dimensions from pure fit-inside math (pinned
 * to generateStrapiFormats by the parity test), byte sizes from the S3
 * listing. Missing non-AVIF variants or unexpected extra objects mark the
 * image ambiguous; missing AVIF twins are simply omitted (phase 14 pass 2
 * settles them once and the guard may legitimately have dropped them).
 */
export function reconstructFormatsFromListing(
  input: ReconstructInput,
): ReconstructResult {
  const max = input.maxDimension ?? IMAGE_OPTIMIZATION.maxDimension;
  const ambiguous: string[] = [];
  const s3Keys: string[] = [];

  const optimized = OPTIMIZED_MASTER_EXTS.has(input.masterExt.toLowerCase());
  const master = optimized
    ? fitInside(input.sourceWidth, input.sourceHeight, max, max)
    : { width: input.sourceWidth, height: input.sourceHeight };

  const expectedKeys = new Set<string>([input.masterKey]);
  let formatsJson: Record<string, any> | null = null;

  if (optimized) {
    formatsJson = {};
    const targets = formatTargets(master.width, master.height, input.masterMime);
    for (const target of targets) {
      const isAvif = target.kind === "avif";
      const ext = isAvif ? ".avif" : input.masterExt;
      const mime = isAvif ? "image/avif" : input.masterMime;
      const variantHash = `${target.filePrefix}${input.slug}`;
      const key = `${input.keyPrefix}${variantHash}${ext}`;
      expectedKeys.add(key);
      const sizeBytes = input.sizesByKey.get(key);
      if (sizeBytes === undefined) {
        if (isAvif) continue; // guard-dropped or never generated — omit
        ambiguous.push(`missing variant ${key}`);
        continue;
      }
      const dims = fitInside(master.width, master.height, target.width, target.height);
      formatsJson[target.key] = {
        name: `${target.filePrefix}${input.slug}${ext}`,
        hash: variantHash,
        ext,
        mime,
        path: null,
        width: dims.width,
        height: dims.height,
        size: parseFloat((sizeBytes / 1000).toFixed(2)),
        sizeInBytes: sizeBytes,
        url: `${input.urlPrefix}/${key}`,
      };
      s3Keys.push(key);
    }
    if (Object.keys(formatsJson).length === 0) formatsJson = null;
  }

  // Unexpected objects in the image's folder mean the layout doesn't match
  // what this code would have produced — safer to reprocess than to guess.
  for (const key of input.sizesByKey.keys()) {
    if (!expectedKeys.has(key)) ambiguous.push(`unexpected object ${key}`);
  }

  return { formatsJson, width: master.width, height: master.height, s3Keys, ambiguous };
}
