import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { IMAGE_BREAKPOINTS, IMAGE_OPTIMIZATION as OPT } from '../../constants/image';
import { slugify } from '../../constants/slugify';

const bytesToKbytes = (bytes: number) => Math.round((bytes / 1000) * 100) / 100;

// SEO slug for filenames. Shares the admin's slugify so an uploaded logo and
// the entity it belongs to fold accents/ligatures the same way. Only the
// length cap and the empty-input fallback are local concerns.
// NOTE: the migration's slugifyFileName is a now-divergent copy — leave it be,
// it reproduces the keys already stored for the WordPress import.
const slugifyFileName = (name: string): string => {
  // Re-strip edge dashes: the cap can land mid-word and leave a trailing one.
  const slug = slugify(name).slice(0, 80).replace(/-+$/, '');
  return slug || 'image';
};

// Folder-per-image scheme for admin uploads, matching the migration:
//   uploads/{slug}-{rand8}/{slug}.webp  + variants in the same folder.
// The folder lives INSIDE file.hash ("slug-rand8/slug") — the aws-s3
// provider's sanitizer preserves interior slashes and recomputes keys from
// the persisted hash on delete/replace, so cleanup keeps working.
const splitFolderHash = (hash: string): { folder: string; base: string } | null => {
  const i = hash.indexOf('/');
  return i > 0 ? { folder: hash.slice(0, i), base: hash.slice(i + 1) } : null;
};

// Replaces the upload plugin's image-manipulation `optimize` so every upload
// is capped to OPT.maxDimension, EXIF-oriented + stripped, and jpeg/png are
// converted to WebP. Because `optimize` runs before responsive formats are
// generated (and format temp files carry no extension), all thumbnail/
// small/medium/large variants automatically inherit the converted output.
// NOTE: this ordering is undocumented @strapi/upload internal behavior —
// re-verify uploads still produce WebP variants after upgrading Strapi.
const isSvg = (file: any): boolean =>
  file?.mime === 'image/svg+xml' ||
  /\.svg$/i.test(file?.ext ?? '') ||
  /\.svg$/i.test(file?.name ?? '');

export default (plugin: any) => {
  const base = plugin.services['image-manipulation'];

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
    // Keep the raw upload around so AVIF twins encode from the pre-webp
    // source (single-generation, not double-lossy). Consumed and removed in
    // generateResponsiveFormats below; never persisted (non-schema props are
    // dropped by the db layer, like tmpWorkingDirectory).
    newFile.__sourceFilepath = file.filepath;

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

    return Object.assign(newFile, {
      width: info.width,
      height: info.height,
      size: bytesToKbytes(info.size),
      sizeInBytes: info.size,
    });
  };

  // Stock variant hashes are `${sizeKey}_${file.hash}` — with a folder inside
  // the hash that becomes `small_slug-rand/slug` (wrong folder). Relocate the
  // size prefix inside the folder: `slug-rand/small_slug`, name `small_slug.ext`.
  const relocateVariant = (sizeKey: string, variantFile: any, masterHash: string) => {
    const parts = splitFolderHash(masterHash);
    if (!parts || !variantFile) return variantFile;
    variantFile.hash = `${parts.folder}/${sizeKey}_${parts.base}`;
    const ext = variantFile.ext ?? path.extname(variantFile.name ?? '');
    variantFile.name = `${sizeKey}_${parts.base}${ext}`;
    return variantFile;
  };

  const generateThumbnail = async (file: any) => {
    const thumbnail = await base.generateThumbnail(file);
    return relocateVariant('thumbnail', thumbnail, file.hash ?? '');
  };

  // Append AVIF twin variants (original_avif + small/medium/large_avif) for
  // WebP masters. Entries returned here flow through uploadImage's upload +
  // formats persistence untouched, and remove()/replace() iterate all formats
  // keys, so twins are cleaned up automatically (verified in 5.39 dist).
  const generateResponsiveFormats = async (file: any) => {
    // CAPTURE THE SOURCE PATHS FIRST — do not move this below the await.
    // uploadImage starts provider.upload(master) WITHOUT awaiting it, and
    // provider.upload deletes file.filepath the moment it completes
    // (@strapi/upload services/provider.js). The base call below is hundreds
    // of milliseconds of sharp work, which is long enough for the S3 upload to
    // win that race and strip filepath — which silently disabled every AVIF
    // twin. Stock resizeFileTo never noticed because it falls back to
    // file.getStream() when filepath is gone; our encoder reads from a path.
    const sourceFilepath: string | undefined = file.__sourceFilepath;
    const masterFilepath: string | undefined = file.filepath;
    delete file.__sourceFilepath;

    const rawFormats = (await base.generateResponsiveFormats(file)) ?? [];
    // Move each variant's size prefix inside the image folder (no-op for
    // flat hashes, e.g. gif pass-throughs or pre-folder legacy replaces).
    const baseFormats = rawFormats.map((entry: any) =>
      entry?.key && entry?.file
        ? { ...entry, file: relocateVariant(entry.key, entry.file, file.hash ?? '') }
        : entry
    );

    if (!OPT.generateAvifTwins || file.mime !== 'image/webp') {
      return baseFormats;
    }

    // Prefer the pre-webp original (single-generation encode); fall back to the
    // optimized master. Both temp files outlive the property deletion — only
    // the reference is removed, the bytes stay until the tmp dir is cleaned.
    const srcPath = [sourceFilepath, masterFilepath].find(
      (candidate): candidate is string => Boolean(candidate) && fs.existsSync(candidate as string)
    );
    if (!srcPath) {
      // Loud on purpose: this is the failure mode that hid the race for weeks.
      strapi.log.error(
        `[upload] AVIF twins skipped for ${file.hash}: no readable source file ` +
          `(source=${sourceFilepath ?? 'unset'} master=${masterFilepath ?? 'unset'})`
      );
      return baseFormats;
    }

    try {
      const breakpoints: Record<string, number> = strapi.config.get(
        'plugin::upload.breakpoints',
        { ...IMAGE_BREAKPOINTS }
      );
      // JSON keys keep `_avif` (must differ from the webp entries); FILENAMES
      // drop it — the .avif extension already carries the format. Twin of
      // `medium_x.webp` is `medium_x.avif`; the original's twin is `x.avif`.
      // hash+ext stays unique per S3 object, so provider delete works.
      const targets = [
        { key: 'original_avif', filePrefix: '', w: file.width, h: file.height },
        ...Object.entries(breakpoints)
          .filter(([, bp]) => bp < (file.width ?? 0) || bp < (file.height ?? 0))
          .map(([k, bp]) => ({ key: `${k}_avif`, filePrefix: `${k}_`, w: bp, h: bp })),
      ];

      const parts = splitFolderHash(file.hash ?? '');
      const twins = await Promise.all(
        targets.map(async ({ key, filePrefix, w, h }) => {
          // Folder hashes: `slug-rand/small_slug`; flat (legacy replace):
          // `small_hash`. Filenames drop `_avif` — the extension carries it.
          const hash = parts
            ? `${parts.folder}/${filePrefix}${parts.base}`
            : `${filePrefix}${file.hash}`;
          const nameStem = parts
            ? parts.base
            : path.basename(file.name, path.extname(file.name));
          const outPath = path.join(
            file.tmpWorkingDirectory ?? os.tmpdir(),
            `avif-${filePrefix}${(parts?.base ?? file.hash) || 'img'}`
          );
          const info = await sharp(srcPath)
            .rotate()
            .resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
            .avif({ quality: OPT.avif.quality, effort: OPT.avif.effort })
            .toFile(outPath);

          return {
            key,
            file: {
              name: `${filePrefix}${nameStem}.avif`,
              hash,
              ext: '.avif',
              mime: 'image/avif',
              filepath: outPath,
              path: file.path || null,
              getStream: () => fs.createReadStream(outPath),
              width: info.width,
              height: info.height,
              size: bytesToKbytes(info.size),
              sizeInBytes: info.size,
            },
          };
        })
      );

      // Size guard: browsers always prefer the avif <source>, so a twin that
      // came out >= its webp counterpart would make pages HEAVIER. Drop it.
      const webpBytes = new Map<string, number>([
        ['original_avif', file.sizeInBytes ?? Infinity],
        ...baseFormats
          .filter((f: any) => f?.key && f?.file?.sizeInBytes)
          .map((f: any) => [`${f.key}_avif`, f.file.sizeInBytes] as [string, number]),
      ]);
      const keptTwins = twins.filter((t) => {
        const counterpart = webpBytes.get(t.key);
        const keep = !counterpart || t.file.sizeInBytes < counterpart;
        if (!keep) {
          try {
            fs.unlinkSync(t.file.filepath);
          } catch {
            /* tmp dir cleanup handles it */
          }
        }
        return keep;
      });

      return [...baseFormats, ...keptTwins];
    } catch (err) {
      // An AVIF encoder failure must never fail the upload — webp formats
      // alone are a fine outcome; the frontend degrades automatically. Logged
      // at ERROR, not warn: half the image pipeline silently going missing is
      // not a debug-level event, and a warn here hid exactly that.
      strapi.log.error(`[upload] AVIF twin generation failed: ${err}`);
      return baseFormats;
    }
  };

  // Stock FORMATS_TO_RESIZE excludes avif, so AVIF masters would get NO
  // formats at all. Widen the check: resizeFileTo's extension-less temp
  // files keep the input format, so an avif master yields avif variants.
  const isResizableImage = async (file: any) => {
    if (await base.isResizableImage(file)) return true;
    if (!file.filepath) return false;
    try {
      const { format } = await sharp(file.filepath).metadata();
      return format === 'heif' || format === 'avif';
    } catch {
      return false;
    }
  };

  plugin.services['image-manipulation'] = {
    ...base,
    optimize,
    generateThumbnail,
    generateResponsiveFormats,
    isResizableImage,
  };
  return plugin;
};
