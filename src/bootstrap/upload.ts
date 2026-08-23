import type { Core } from '@strapi/strapi';
import { CULTURE_GALLERY_MEDIA_FOLDER_NAME } from '../constants/media-folders';

// Media Library settings live in the DB plugin store (not file config).
// Ensure responsive formats + optimization + orientation are on everywhere.
// Note: like ensurePublicReadPermissions (src/bootstrap/permissions.ts), this
// re-asserts on every boot, so switching the settings off in the admin UI will
// not stick across a restart.
export async function ensureUploadSettings(strapi: Core.Strapi): Promise<void> {
  const uploadService: any = strapi.plugin('upload').service('upload');
  const current = (await uploadService.getSettings()) ?? {};
  const desired = {
    ...current,
    sizeOptimization: true,
    responsiveDimensions: true,
    autoOrientation: true,
  };

  if (JSON.stringify(desired) !== JSON.stringify(current)) {
    await uploadService.setSettings(desired);
    strapi.log.info('[upload] enabled sizeOptimization/responsiveDimensions/autoOrientation');
  }
}

export async function ensureCultureGalleryMediaFolder(
  strapi: Core.Strapi,
): Promise<void> {
  const folders: any = strapi.db.query('plugin::upload.folder');
  const existing = await folders.findOne({
    where: { name: CULTURE_GALLERY_MEDIA_FOLDER_NAME },
    select: ['id'],
  });
  if (existing) return;

  await strapi.plugin('upload').service('folder').create({
    name: CULTURE_GALLERY_MEDIA_FOLDER_NAME,
    parent: null,
  });
  strapi.log.info(
    `[upload] created ${CULTURE_GALLERY_MEDIA_FOLDER_NAME} media folder`,
  );
}
