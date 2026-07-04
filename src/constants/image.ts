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
} as const;
