// Image optimization knobs for CMS uploads.
// Twin copy lives in migration/src/utils/image-optimizer.ts — keep in sync.
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
