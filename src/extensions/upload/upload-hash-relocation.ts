// Upload HASH RELOCATION: the folder-per-image hash scheme and moving each
// variant's size prefix inside the image folder. One of the modules split
// out of strapi-server.ts.
import path from 'path';
import { slugify } from '../../constants/slugify';

// SEO slug for filenames. Shares the admin's slugify so an uploaded logo and
// the entity it belongs to fold accents/ligatures the same way. Only the
// length cap and the empty-input fallback are local concerns.
// NOTE: the migration's slugifyFileName is a now-divergent copy — leave it be,
// it reproduces the keys already stored for the WordPress import.
export const slugifyFileName = (name: string): string => {
// Re-strip edge dashes: the cap can land mid-word and leave a trailing one.
const slug = slugify(name).slice(0, 80).replace(/-+$/, '');
return slug || 'image';
};

// Folder-per-image scheme for admin uploads, matching the migration:
//   uploads/{slug}-{rand8}/{slug}.webp  + variants in the same folder.
// The folder lives INSIDE file.hash ("slug-rand8/slug") — the aws-s3
// provider's sanitizer preserves interior slashes and recomputes keys from
// the persisted hash on delete/replace, so cleanup keeps working.
export const splitFolderHash = (hash: string): { folder: string; base: string } | null => {
const i = hash.indexOf('/');
return i > 0 ? { folder: hash.slice(0, i), base: hash.slice(i + 1) } : null;
};

// Stock variant hashes are `${sizeKey}_${file.hash}` — with a folder inside
// the hash that becomes `small_slug-rand/slug` (wrong folder). Relocate the
// size prefix inside the folder: `slug-rand/small_slug`, name `small_slug.ext`.
export const relocateVariant = (sizeKey: string, variantFile: any, masterHash: string) => {
  const parts = splitFolderHash(masterHash);
  if (!parts || !variantFile) return variantFile;
  variantFile.hash = `${parts.folder}/${sizeKey}_${parts.base}`;
  const ext = variantFile.ext ?? path.extname(variantFile.name ?? '');
  variantFile.name = `${sizeKey}_${parts.base}${ext}`;
  return variantFile;
};

export const createGenerateThumbnail = ({ base }: { base: any }) => {
  const generateThumbnail = async (file: any) => {
    const thumbnail = await base.generateThumbnail(file);
    return relocateVariant('thumbnail', thumbnail, file.hash ?? '');
  };
  return generateThumbnail;
};
