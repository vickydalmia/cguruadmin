// Upload MASTER OPTIMIZATION: SVG rejection, background-colour capture,
// EXIF-orient + resize + WebP conversion of the master file, and the
// folder-hash rewrite for fresh uploads. One of the modules split out of
// strapi-server.ts.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp, { type FormatEnum, type Metadata } from 'sharp';
import {
  CULTURE_GALLERY_IMAGE_OPTIMIZATION,
  IMAGE_BREAKPOINTS,
  IMAGE_OPTIMIZATION as OPT,
} from '../../constants/image';
import { calculateImageBackgroundColour } from '../../utils/image-background-colour';
import {
  slugifyFileName,
  splitFolderHash,
} from './upload-hash-relocation';

export const bytesToKbytes = (bytes: number) => Math.round((bytes / 1000) * 100) / 100;

// Replaces the upload plugin's image-manipulation `optimize` so every upload
// is capped, EXIF-oriented + stripped, and jpeg/png are converted to WebP.
// The default profile is unchanged; only media explicitly placed in the
// Culture Gallery folder gets the larger, higher-quality photo profile.
// NOTE: this ordering is undocumented @strapi/upload internal behavior —
// re-verify uploads still produce WebP variants after upgrading Strapi.
const isSvg = (file: any): boolean =>
file?.mime === 'image/svg+xml' ||
/\.svg$/i.test(file?.ext ?? '') ||
/\.svg$/i.test(file?.name ?? '');

export const createImageOptimization = ({
  base,
  isCultureGalleryUpload,
  attachDealImageMetadata,
}: {
  base: any;
  isCultureGalleryUpload: (file: any) => Promise<boolean>;
  attachDealImageMetadata: (target: any, sourcePath?: string) => any;
}) => {
  // enhanceAndValidateFile calls isImage before optimize and then the upload
  // service calls it again before persistence. Calculate on the first call
  // from the original temporary file; the own-property guard makes the
  // second call free and also preserves a deliberate null on failure.
  const isImage = async (file: any) => {
    const result = await base.isImage(file);
    if (Object.prototype.hasOwnProperty.call(file, 'backgroundColour')) {
      return result;
    }

    if (!result || !file.filepath) {
      file.backgroundColour = null;
      return result;
    }

    try {
      file.backgroundColour = await calculateImageBackgroundColour(file.filepath);
    } catch (error) {
      file.backgroundColour = null;
      strapi.log.warn(
        `[upload] Background colour calculation failed for ${file.name ?? 'image'}: ${error}`,
      );
    }
    return result;
  };

  const optimize = async (file: any) => {
    // Reject SVG uploads: an SVG can carry inline <script>, so serving one
    // same-origin is stored XSS. sharp doesn't rasterize away the payload, so
    // block it outright (uploads are admin-only; use PNG/WebP for logos).
    // Bootstrap forces sizeOptimization on, so every image reaches optimize.
    if (isSvg(file)) {
      throw new Error('SVG uploads are not allowed. Please upload PNG, JPG or WebP.');
    }

    const settings =
      (await strapi.plugin('upload').service('upload').getSettings()) ?? {};

    if (settings.sizeOptimization === false) {
      return attachDealImageMetadata(
        await base.optimize(file),
        file.filepath,
      );
    }

    if (!file.filepath) {
      // Stream-only input (no temp file) — fall back to stock behavior.
      return attachDealImageMetadata(
        await base.optimize(file),
        file.filepath,
      );
    }

    let meta: Metadata;
    try {
      meta = await sharp(file.filepath).metadata();
    } catch {
      return attachDealImageMetadata(
        await base.optimize(file),
        file.filepath,
      );
    }

    // sharp reports AVIF sources as "heif" (AVIF is HEIF-family).
    const rawFormat = meta.format as string | undefined;
    const format = rawFormat === 'heif' ? 'avif' : rawFormat;
    if (!format) return attachDealImageMetadata(file, file.filepath);

    const toWebp = (OPT.convertToWebp as readonly string[]).includes(format);
    const keepFormat = (OPT.recompress as readonly string[]).includes(format);
    if (!toWebp && !keepFormat) {
      // gif/svg/etc. — never re-encoded here.
      return attachDealImageMetadata(file, file.filepath);
    }

    // 'avif' is a valid toFormat target but lives outside FormatEnum's keys
    // in sharp 0.35's typings, hence the widened union.
    const outFormat = (toWebp ? 'webp' : format) as 'avif' | keyof FormatEnum;
    const outPath = path.join(
      file.tmpWorkingDirectory ?? os.tmpdir(),
      `optimized-${file.hash}`
    );
    const cultureGalleryUpload = await isCultureGalleryUpload(file);
    const profile = cultureGalleryUpload
      ? CULTURE_GALLERY_IMAGE_OPTIMIZATION
      : OPT;

    const needsResize =
      (meta.width ?? 0) > profile.maxDimension ||
      (meta.height ?? 0) > profile.maxDimension;

    const transformer = sharp(file.filepath)
      .rotate()
      .resize({
        width: profile.maxDimension,
        height: profile.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      });
    const info = outFormat === 'webp' && cultureGalleryUpload
      ? await transformer
          .webp({
            quality: profile.quality,
            effort: CULTURE_GALLERY_IMAGE_OPTIMIZATION.webp.effort,
            smartSubsample:
              CULTURE_GALLERY_IMAGE_OPTIMIZATION.webp.smartSubsample,
          })
          .toFile(outPath)
      : await transformer
          .toFormat(outFormat, { quality: profile.quality })
          .toFile(outPath);

    // Same-format re-encode that got bigger without needing a resize:
    // keep the original bytes (parity with stock optimize behavior).
    if (!toWebp && !needsResize && meta.size && info.size > meta.size) {
      if (cultureGalleryUpload) {
        file.__sourceFilepath = file.filepath;
        file.__imageOptimizationProfile = 'culture-gallery';
      }
      return attachDealImageMetadata(file, file.filepath);
    }

    const newFile = { ...file };
    newFile.filepath = outPath;
    newFile.getStream = () => fs.createReadStream(outPath);
    if (toWebp) {
      newFile.ext = '.webp';
      newFile.mime = 'image/webp';
    }
    // Keep the raw upload around so AVIF twins encode from the pre-webp
    // source (single-generation, not double-lossy). Consumed and removed in
    // generateResponsiveFormats below; never persisted (non-schema props are
    // dropped by the db layer, like tmpWorkingDirectory).
    newFile.__sourceFilepath = file.filepath;
    if (cultureGalleryUpload) {
      newFile.__imageOptimizationProfile = 'culture-gallery';
    }

    // Rewrite the hash to the folder scheme (slug-rand8/slug) — unless this
    // is a replace(), which pins the existing hash (keep old key = old URL).
    // Stock generateThumbnail/resizeFileTo write tmp files named after the
    // (now slash-containing) hash, so precreate the tmp subdirs they'll hit.
    const existing = splitFolderHash(file.hash ?? '');
    if (!existing && file.tmpWorkingDirectory) {
      const slug = slugifyFileName(
        path.basename(file.name ?? 'image', path.extname(file.name ?? ''))
      );
      const randSource = (file.hash ?? '').split('_').pop() ?? '';
      const rand8 = (randSource || crypto.randomBytes(6).toString('hex')).slice(0, 8);
      const folder = `${slug}-${rand8}`;
      newFile.hash = `${folder}/${slug}`;

      const breakpoints: Record<string, number> = strapi.config.get(
        'plugin::upload.breakpoints',
        { ...IMAGE_BREAKPOINTS }
      );
      for (const prefix of ['thumbnail', ...Object.keys(breakpoints)]) {
        fs.mkdirSync(path.join(file.tmpWorkingDirectory, `${prefix}_${folder}`), {
          recursive: true,
        });
      }
    }

    return attachDealImageMetadata(Object.assign(newFile, {
      width: info.width,
      height: info.height,
      size: bytesToKbytes(info.size),
      sizeInBytes: info.size,
    }), file.filepath);
  };
  return { isImage, optimize };
};
