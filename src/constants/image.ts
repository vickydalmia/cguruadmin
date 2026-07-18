// Image optimization knobs + responsive variant matrix for CMS uploads.
// Single source of truth: config/plugins.ts, src/extensions/upload and
// migration/src/utils/image-optimizer.ts all import from here.
export const IMAGE_OPTIMIZATION = {
  /** Longest side of the stored original after capping. */
  maxDimension: 1920,
  quality: 80,
  /** Source formats replaced by WebP (ext/mime/url all become .webp). */
  convertToWebp: ['jpeg', 'png'],
  /** Formats kept as-is but capped and re-encoded. */
  recompress: ['webp', 'avif', 'tiff'],
  /** AVIF twin variants (original_avif/small_avif/medium_avif/large_avif). */
  generateAvifTwins: true,
  /**
   * q50/effort 4 (sharp's own avif default quality): measured ~63% of webp
   * q80 bytes across this catalog incl. small logos. q60/effort 3 was a trap —
   * 91-105% of webp on small images. Full 4:4:4 chroma kept for banner text.
   */
  avif: { quality: 50, effort: 4 },
} as const;

/**
 * Responsive format sizes generated on upload (originals are capped at
 * maxDimension by src/extensions/upload — no 1920 breakpoint). xsmall serves
 * ~150px card slots at DPR 2 — without it the smallest variant is 500px and
 * thumbnails download 3x the pixels they render (Lighthouse "improve image
 * delivery").
 */
export const IMAGE_BREAKPOINTS = {
  large: 1000,
  medium: 750,
  small: 500,
  xsmall: 320,
} as const;

/** Strapi's internal thumbnail format size (upload plugin default). */
export const THUMBNAIL = { width: 245, height: 156 } as const;
