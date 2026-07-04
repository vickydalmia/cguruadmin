import sharp from "sharp";

/**
 * Image optimization settings.
 *
 * Twin of cguruadmin/src/constants/image.ts — keep values in sync.
 */
export const IMAGE_OPTIMIZATION = {
  maxDimension: 1920,
  quality: 80,
  convertToWebp: ["jpeg", "png"],
  recompress: ["webp", "avif", "tiff"],
} as const;

/** Strapi responsive breakpoints (matches Strapi upload plugin defaults). */
const BREAKPOINTS: Record<string, number> = {
  large: 1000,
  medium: 750,
  small: 500,
};

const THUMBNAIL = { width: 245, height: 156 };

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
  const { width, height, ext, mime, hashBase, nameBase, urlPrefix, keyPrefix } =
    opts;
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

  const formatsJson: Record<string, any> = {};
  const uploads: FormatVariantUpload[] = [];

  for (const target of targets) {
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

  return { formatsJson, uploads };
}
