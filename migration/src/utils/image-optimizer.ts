import sharp from "sharp";
import { logger } from "./logger.js";

// Single source of truth for optimization knobs + variant matrix lives in
// cguruadmin/src/constants/image.ts; re-exported for migration callers.
// Dynamic import is required: the constants file sits in a CJS package scope
// (cguruadmin has no "type":"module"), and a STATIC named import of tsx's
// CJS-transpiled output fails at runtime (Node's cjs-module-lexer cannot see
// esbuild's getter exports) — only tsx's dynamic-import interop keeps names.
const { IMAGE_BREAKPOINTS, IMAGE_OPTIMIZATION, THUMBNAIL } = await import(
  "../../../src/constants/image.js"
);
export { IMAGE_BREAKPOINTS, IMAGE_OPTIMIZATION, THUMBNAIL };

/** Strapi responsive breakpoints (spread keeps a mutable Record shape). */
export const BREAKPOINTS: Record<string, number> = { ...IMAGE_BREAKPOINTS };

const FORMAT_TO_EXT: Record<string, string> = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  avif: ".avif",
  tiff: ".tiff",
};

const FORMAT_TO_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  tiff: "image/tiff",
};

export interface OptimizedImage {
  buffer: Buffer;
  ext: string;
  mime: string;
  width: number;
  height: number;
  sizeInBytes: number;
  converted: boolean;
}

/** Encode the pipeline in the given target format at the configured quality. */
function encode(pipeline: sharp.Sharp, format: string): sharp.Sharp {
  const quality = IMAGE_OPTIMIZATION.quality;
  switch (format) {
    case "webp":
      return pipeline.webp({ quality });
    case "avif":
      return pipeline.avif({ quality });
    case "tiff":
      return pipeline.tiff({ quality });
    case "jpeg":
      return pipeline.jpeg({ quality });
    case "png":
      return pipeline.png({ quality });
    default:
      return pipeline;
  }
}

/** Map a file extension (".webp", ".tif", ...) to a sharp format name. */
function extToFormat(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".png":
      return "png";
    case ".webp":
      return "webp";
    case ".avif":
      return "avif";
    case ".tif":
    case ".tiff":
      return "tiff";
    default:
      return "webp";
  }
}

/**
 * Optimize an original image buffer:
 *   - bake EXIF orientation (.rotate())
 *   - downscale to fit inside maxDimension x maxDimension (never enlarge)
 *   - jpeg/png  → convert to webp (converted = true)
 *   - webp/avif/tiff → re-encode same format at quality 80
 *     (original buffer is kept when the re-encode came out LARGER and
 *      no resize was needed)
 *   - anything else (gif/svg/unknown/animated) → null: caller passes the
 *     original file through untouched.
 */
export async function optimizeOriginal(
  input: Buffer
): Promise<OptimizedImage | null> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return null; // not decodable by sharp → pass through
  }

  // sharp reports AVIF sources as "heif" (AVIF is HEIF-family).
  const format = meta.format === "heif" ? "avif" : (meta.format ?? "");
  const convert = (IMAGE_OPTIMIZATION.convertToWebp as readonly string[]).includes(format);
  const recompress = (IMAGE_OPTIMIZATION.recompress as readonly string[]).includes(format);
  if (!convert && !recompress) return null;

  // Animated images (animated webp) would lose animation on re-encode.
  if ((meta.pages ?? 1) > 1) return null;

  // Oriented source dimensions (EXIF orientation 5-8 swaps width/height).
  const swapped = (meta.orientation ?? 1) >= 5;
  const srcWidth = (swapped ? meta.height : meta.width) ?? 0;
  const srcHeight = (swapped ? meta.width : meta.height) ?? 0;
  const max = IMAGE_OPTIMIZATION.maxDimension;
  const willResize = srcWidth > max || srcHeight > max;

  const targetFormat = convert ? "webp" : format;
  const pipeline = encode(
    sharp(input)
      .rotate()
      .resize({
        width: max,
        height: max,
        fit: "inside",
        withoutEnlargement: true,
      }),
    targetFormat
  );

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  const ext = FORMAT_TO_EXT[targetFormat];
  const mime = FORMAT_TO_MIME[targetFormat];

  // Same-format recompress that got bigger without any resize benefit:
  // keep the original bytes.
  if (!convert && !willResize && data.length >= input.length) {
    return {
      buffer: input,
      ext,
      mime,
      width: srcWidth || info.width,
      height: srcHeight || info.height,
      sizeInBytes: input.length,
      converted: false,
    };
  }

  return {
    buffer: data,
    ext,
    mime,
    width: info.width,
    height: info.height,
    sizeInBytes: data.length,
    converted: convert,
  };
}

/**
 * SEO-friendly slug from a file name (no extension): lowercase, alnum + '-',
 * collapsed. Falls back to "image" for names that slugify to nothing.
 */
export function slugifyFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "image";
}

export interface FormatVariantUpload {
  key: string;
  buffer: Buffer;
  contentType: string;
}

export interface GenerateFormatsOptions {
  width: number;
  height: number;
  ext: string;
  mime: string;
  /** Basename of the original S3 object without extension, e.g. "a1b2c3d4e5f60718_photo". */
  hashBase: string;
  /** Original file name without extension, e.g. "photo". */
  nameBase: string;
  /** URL prefix (CDN/base URL) without trailing slash; entry.url = urlPrefix + "/" + s3Key. */
  urlPrefix: string;
  /** S3 key prefix including trailing slash (e.g. "uploads/"), or "" — same root path as the original. */
  keyPrefix: string;
  /**
   * Pre-optimization source bytes to encode AVIF twins from (highest-quality
   * input available). Falls back to the optimized buffer when omitted.
   */
  avifSource?: Buffer;
  /**
   * Restrict generation to these format keys (incl. `_avif` twin keys) —
   * backfills recompute only what a row is missing. Omitted = every due key.
   */
  onlyKeys?: Set<string>;
  /**
   * Byte sizes of ALREADY-UPLOADED variants keyed by format key ("small",
   * "medium", ...) so the AVIF size guard can compare a twin against a webp
   * tier skipped via onlyKeys. Values are bytes (entry.sizeInBytes — NOT
   * entry.size, which is KB via /1000).
   */
  existingSizes?: Record<string, number>;
}

/**
 * Generate AVIF "twin" variants from the (ideally pre-optimization) source:
 *   - original_avif at the optimized original's dimensions
 *   - small_avif / medium_avif / large_avif for breakpoints 500/750/1000
 *     when the breakpoint is smaller than the width or height
 *
 * Entries mirror generateStrapiFormats entries with ext ".avif" and mime
 * "image/avif"; the S3 key is `<formatKey>_<hashBase>.avif` under keyPrefix.
 * Encode failures are logged and the target skipped — this never throws.
 */
export async function generateAvifTwins(
  sourceBuffer: Buffer,
  opts: {
    width: number;
    height: number;
    hashBase: string;
    nameBase: string;
    urlPrefix: string;
    keyPrefix: string;
    /**
     * Byte sizes of the webp counterparts keyed by twin key (original_avif/
     * small_avif/...). A twin that comes out >= its counterpart is dropped —
     * browsers always prefer the avif <source>, so a bigger avif would make
     * pages heavier.
     */
    compareTo?: Record<string, number>;
    /** Restrict generation to these twin keys (backfills). Omitted = all due. */
    onlyKeys?: Set<string>;
  }
): Promise<{
  formatsJson: Record<string, any>;
  uploads: FormatVariantUpload[];
  /** Twins skipped because the webp counterpart was already smaller. */
  droppedLarger: number;
}> {
  const { width, height, hashBase, nameBase, urlPrefix, keyPrefix, compareTo, onlyKeys } = opts;
  const { quality, effort } = IMAGE_OPTIMIZATION.avif;
  let droppedLarger = 0;

  // JSON keys keep the `_avif` suffix (they must be distinct from the webp
  // entries), but FILENAMES drop it — the .avif extension already carries the
  // format, so the twin of `medium_slug.webp` is simply `medium_slug.avif`
  // and the original's twin is `slug.avif`. Same basename + different ext
  // never collides, on S3 or in Strapi's provider-key derivation.
  const targets: Array<{
    key: string;
    filePrefix: string;
    width: number;
    height: number;
  }> = [{ key: "original_avif", filePrefix: "", width, height }];
  for (const [key, bp] of Object.entries(BREAKPOINTS)) {
    if (bp < width || bp < height) {
      targets.push({ key: `${key}_avif`, filePrefix: `${key}_`, width: bp, height: bp });
    }
  }
  const dueTargets = onlyKeys
    ? targets.filter((target) => onlyKeys.has(target.key))
    : targets;

  const formatsJson: Record<string, any> = {};
  const uploads: FormatVariantUpload[] = [];

  for (const target of dueTargets) {
    try {
      const { data, info } = await sharp(sourceBuffer)
        .rotate()
        .resize({
          width: target.width,
          height: target.height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .avif({ quality, effort })
        .toBuffer({ resolveWithObject: true });

      const counterpart = compareTo?.[target.key];
      if (counterpart && data.length >= counterpart) {
        droppedLarger++;
        continue;
      }

      const variantHash = `${target.filePrefix}${hashBase}`;
      const s3Key = `${keyPrefix}${variantHash}.avif`;

      formatsJson[target.key] = {
        name: `${target.filePrefix}${nameBase}.avif`,
        hash: variantHash,
        ext: ".avif",
        mime: "image/avif",
        path: null,
        width: info.width,
        height: info.height,
        size: parseFloat((data.length / 1000).toFixed(2)),
        sizeInBytes: data.length,
        url: `${urlPrefix}/${s3Key}`,
      };
      uploads.push({ key: s3Key, buffer: data, contentType: "image/avif" });
    } catch (err: any) {
      logger.warn(
        `AVIF twin encode failed for ${target.key} (${hashBase}): ${err.message} — skipping target`
      );
    }
  }

  return { formatsJson, uploads, droppedLarger };
}

/**
 * Generate Strapi-style responsive format variants (thumbnail/small/medium/large)
 * from an already-optimized original. All variants inherit the optimized
 * original's format (webp when the original was converted).
 *
 * The S3 key of a variant is `<formatKey>_<hashBase><ext>` under the same root
 * path the original uses, so entry.hash + entry.ext === key basename.
 */
export async function generateStrapiFormats(
  optimizedBuffer: Buffer,
  opts: GenerateFormatsOptions
): Promise<{
  formatsJson: Record<string, any>;
  uploads: FormatVariantUpload[];
}> {
  const {
    width,
    height,
    ext,
    mime,
    hashBase,
    nameBase,
    urlPrefix,
    keyPrefix,
    onlyKeys,
    existingSizes,
  } = opts;
  const format = extToFormat(ext);

  const targets: Array<{ key: string; width: number; height: number }> = [];
  if (width > THUMBNAIL.width || height > THUMBNAIL.height) {
    targets.push({ key: "thumbnail", ...THUMBNAIL });
  }
  for (const [key, bp] of Object.entries(BREAKPOINTS)) {
    if (bp < width || bp < height) {
      targets.push({ key, width: bp, height: bp });
    }
  }
  const dueTargets = onlyKeys
    ? targets.filter((target) => onlyKeys.has(target.key))
    : targets;

  const formatsJson: Record<string, any> = {};
  const uploads: FormatVariantUpload[] = [];

  for (const target of dueTargets) {
    const pipeline = encode(
      sharp(optimizedBuffer).resize({
        width: target.width,
        height: target.height,
        fit: "inside",
      }),
      format
    );
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    const variantHash = `${target.key}_${hashBase}`;
    const s3Key = `${keyPrefix}${variantHash}${ext}`;

    formatsJson[target.key] = {
      name: `${target.key}_${nameBase}${ext}`,
      hash: variantHash,
      ext,
      mime,
      path: null,
      width: info.width,
      height: info.height,
      size: parseFloat((data.length / 1000).toFixed(2)),
      sizeInBytes: data.length,
      url: `${urlPrefix}/${s3Key}`,
    };
    uploads.push({ key: s3Key, buffer: data, contentType: mime });
  }

  // AVIF twins: only for webp originals (avif masters already produce avif
  // standard keys above; other mimes are left unchanged).
  if (IMAGE_OPTIMIZATION.generateAvifTwins && mime === "image/webp") {
    // Counterparts for tiers skipped via onlyKeys come from existingSizes
    // (bytes of the already-uploaded webp entries).
    const compareTo: Record<string, number> = {
      original_avif: optimizedBuffer.length,
    };
    for (const key of Object.keys(BREAKPOINTS)) {
      const bytes = formatsJson[key]?.sizeInBytes ?? existingSizes?.[key];
      if (bytes) compareTo[`${key}_avif`] = bytes;
    }
    const twins = await generateAvifTwins(opts.avifSource ?? optimizedBuffer, {
      width,
      height,
      hashBase,
      nameBase,
      urlPrefix,
      keyPrefix,
      compareTo,
      onlyKeys,
    });
    Object.assign(formatsJson, twins.formatsJson);
    uploads.push(...twins.uploads);
  }

  return { formatsJson, uploads };
}

/**
 * Format keys a master with the given dimensions/mime is due to carry:
 * thumbnail when the master exceeds the 245×156 box, one key per breakpoint
 * smaller than either master axis, plus the AVIF twin keys (original_avif/
 * `{key}_avif`) for webp masters. Twin keys are nominal — the size guard in
 * generateAvifTwins may drop any twin whose webp counterpart is already
 * smaller, so rows can legitimately store fewer keys than reported here.
 */
export function expectedFormatKeys(
  width: number,
  height: number,
  mime: string
): string[] {
  const keys: string[] = [];
  if (width > THUMBNAIL.width || height > THUMBNAIL.height) {
    keys.push("thumbnail");
  }
  for (const [key, bp] of Object.entries(BREAKPOINTS)) {
    if (bp < width || bp < height) keys.push(key);
  }
  if (IMAGE_OPTIMIZATION.generateAvifTwins && mime === "image/webp") {
    keys.push("original_avif");
    for (const [key, bp] of Object.entries(BREAKPOINTS)) {
      if (bp < width || bp < height) keys.push(`${key}_avif`);
    }
  }
  return keys;
}
