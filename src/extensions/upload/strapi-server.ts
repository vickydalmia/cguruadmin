import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { IMAGE_OPTIMIZATION as OPT } from '../../constants/image';

const bytesToKbytes = (bytes: number) => Math.round((bytes / 1000) * 100) / 100;

// Replaces the upload plugin's image-manipulation `optimize` so every upload
// is capped to OPT.maxDimension, EXIF-oriented + stripped, and jpeg/png are
// converted to WebP. Because `optimize` runs before responsive formats are
// generated (and format temp files carry no extension), all thumbnail/
// small/medium/large variants automatically inherit the converted output.
// NOTE: this ordering is undocumented @strapi/upload internal behavior —
// re-verify uploads still produce WebP variants after upgrading Strapi.
export default (plugin: any) => {
  const base = plugin.services['image-manipulation'];

  const optimize = async (file: any) => {
    const settings =
      (await strapi.plugin('upload').service('upload').getSettings()) ?? {};

    if (settings.sizeOptimization === false) {
      return base.optimize(file);
    }

    if (!file.filepath) {
      // Stream-only input (no temp file) — fall back to stock behavior.
      return base.optimize(file);
    }

    let meta: sharp.Metadata;
    try {
      meta = await sharp(file.filepath).metadata();
    } catch {
      return base.optimize(file);
    }

    // sharp reports AVIF sources as "heif" (AVIF is HEIF-family).
    const rawFormat = meta.format as string | undefined;
    const format = rawFormat === 'heif' ? 'avif' : rawFormat;
    if (!format) return file;

    const toWebp = (OPT.convertToWebp as readonly string[]).includes(format);
    const keepFormat = (OPT.recompress as readonly string[]).includes(format);
    if (!toWebp && !keepFormat) {
      // gif/svg/etc. — never re-encoded here.
      return file;
    }

    const outFormat = (toWebp ? 'webp' : format) as keyof sharp.FormatEnum;
    const outPath = path.join(
      file.tmpWorkingDirectory ?? os.tmpdir(),
      `optimized-${file.hash}`
    );

    const needsResize =
      (meta.width ?? 0) > OPT.maxDimension || (meta.height ?? 0) > OPT.maxDimension;

    const info = await sharp(file.filepath)
      .rotate()
      .resize({
        width: OPT.maxDimension,
        height: OPT.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFormat(outFormat, { quality: OPT.quality })
      .toFile(outPath);

    // Same-format re-encode that got bigger without needing a resize:
    // keep the original bytes (parity with stock optimize behavior).
    if (!toWebp && !needsResize && meta.size && info.size > meta.size) {
      return file;
    }

    const newFile = { ...file };
    newFile.filepath = outPath;
    newFile.getStream = () => fs.createReadStream(outPath);
    if (toWebp) {
      newFile.ext = '.webp';
      newFile.mime = 'image/webp';
    }

    return Object.assign(newFile, {
      width: info.width,
      height: info.height,
      size: bytesToKbytes(info.size),
      sizeInBytes: info.size,
    });
  };

  plugin.services['image-manipulation'] = { ...base, optimize };
  return plugin;
};
