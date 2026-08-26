// Upload RESPONSIVE FORMATS: single-generation WebP rungs for the Culture
// Gallery profile, AVIF twin variants with the size guard, and the widened
// resizable-image check for AVIF masters. One of the modules split out of
// strapi-server.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  CULTURE_GALLERY_IMAGE_OPTIMIZATION,
  IMAGE_BREAKPOINTS,
  IMAGE_OPTIMIZATION as OPT,
} from '../../constants/image';
import { bytesToKbytes } from './upload-master-optimization';
import { relocateVariant, splitFolderHash } from './upload-hash-relocation';

export const createResponsiveFormats = ({ base }: { base: any }) => {
  // Stock Strapi resizes the already-encoded WebP master without an explicit
  // output profile. Sharp therefore applies its default WebP quality again,
  // creating a second lossy generation. For the opt-in Culture Gallery photo
  // profile, build responsive WebPs directly from the temporary upload so
  // every rung is encoded once. Other folders retain stock byte behaviour.
  const generateWebpResponsiveFormats = async (file: any, sourcePath: string) => {
    const breakpoints: Record<string, number> = strapi.config.get(
      'plugin::upload.breakpoints',
      { ...IMAGE_BREAKPOINTS }
    );
    const formats: Array<{ key: string; file: any }> = [];

    for (const [key, breakpoint] of Object.entries(breakpoints)) {
      if (breakpoint >= (file.width ?? 0) && breakpoint >= (file.height ?? 0)) {
        continue;
      }

      // Match Strapi's temporary path contract. relocateVariant moves the
      // persisted hash into the master's folder after this file is created.
      const temporaryHash = `${key}_${file.hash}`;
      const outPath = path.join(
        file.tmpWorkingDirectory ?? os.tmpdir(),
        temporaryHash
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const info = await sharp(sourcePath)
        .rotate()
        .resize({
          width: breakpoint,
          height: breakpoint,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({
          quality: CULTURE_GALLERY_IMAGE_OPTIMIZATION.quality,
          effort: CULTURE_GALLERY_IMAGE_OPTIMIZATION.webp.effort,
          smartSubsample:
            CULTURE_GALLERY_IMAGE_OPTIMIZATION.webp.smartSubsample,
        })
        .toFile(outPath);

      formats.push({
        key,
        file: {
          name: `${key}_${file.name}`,
          hash: temporaryHash,
          ext: '.webp',
          mime: 'image/webp',
          filepath: outPath,
          path: file.path || null,
          getStream: () => fs.createReadStream(outPath),
          width: info.width,
          height: info.height,
          size: bytesToKbytes(info.size),
          sizeInBytes: info.size,
        },
      });
    }

    return formats;
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
    const cultureGalleryUpload =
      file.__imageOptimizationProfile === 'culture-gallery';
    delete file.__sourceFilepath;
    delete file.__imageOptimizationProfile;

    const readableSource = [sourceFilepath, masterFilepath].find(
      (candidate): candidate is string => Boolean(candidate) && fs.existsSync(candidate as string)
    );
    const rawFormats = cultureGalleryUpload && file.mime === 'image/webp' && readableSource
      ? await generateWebpResponsiveFormats(file, readableSource)
      : ((await base.generateResponsiveFormats(file)) ?? []);
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
          const avifProfile = cultureGalleryUpload
            ? CULTURE_GALLERY_IMAGE_OPTIMIZATION.avif
            : OPT.avif;
          const info = await sharp(srcPath)
            .rotate()
            .resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
            .avif({ quality: avifProfile.quality, effort: avifProfile.effort })
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
      // Widened: sharp 0.35's Metadata.format union omits the heif/avif
      // values it actually reports for AVIF sources.
      const format = (await sharp(file.filepath).metadata()).format as
        | string
        | undefined;
      return format === 'heif' || format === 'avif';
    } catch {
      return false;
    }
  };
  return { generateResponsiveFormats, isResizableImage };
};
