import type { Core } from '@strapi/strapi';
import { CULTURE_GALLERY_MEDIA_FOLDER_NAME } from '../constants/media-folders';
import { TELEGRAM_MEDIA_FOLDER_NAME } from '../constants/telegram';

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

async function ensureRootMediaFolder(strapi: Core.Strapi, name: string): Promise<void> {
  const folders: any = strapi.db.query('plugin::upload.folder');
  const existing = await folders.findOne({
    where: { name },
    select: ['id'],
  });
  if (existing) return;

  await strapi.plugin('upload').service('folder').create({
    name,
    parent: null,
  });
  strapi.log.info(`[upload] created ${name} media folder`);
}

export async function ensureCultureGalleryMediaFolder(
  strapi: Core.Strapi,
): Promise<void> {
  await ensureRootMediaFolder(strapi, CULTURE_GALLERY_MEDIA_FOLDER_NAME);
}

// Re-hosted Telegram channel photos (src/telegram/ingest.ts) land here so
// editors can tell them apart from hand-uploaded assets.
export async function ensureTelegramMediaFolder(strapi: Core.Strapi): Promise<void> {
  await ensureRootMediaFolder(strapi, TELEGRAM_MEDIA_FOLDER_NAME);
}
