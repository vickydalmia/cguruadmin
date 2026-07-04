import type { Core } from '@strapi/strapi';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  'api::deal.deal': ['stores', 'brands', 'categories', 'banks', 'tags'],
  'api::coupon.coupon': ['stores', 'brands', 'categories', 'banks', 'tags'],
};

async function hideRelationsFromContentManager(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const [uid, fieldsToHide] of Object.entries(HIDE_FROM_EDIT)) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const config = await service.findConfiguration(contentType);
      const hidden = new Set(fieldsToHide);

      const prevEdit = config.layouts?.edit ?? [];
      const prevList = config.layouts?.list ?? [];

      const nextEdit = prevEdit
        .map((row: any[]) => row.filter((cell) => !hidden.has(cell.name)))
        .filter((row: any[]) => row.length > 0);
      const nextList = prevList.filter((name: string) => !hidden.has(name));

      const changed =
        JSON.stringify(nextEdit) !== JSON.stringify(prevEdit) ||
        JSON.stringify(nextList) !== JSON.stringify(prevList);

      if (!changed) continue;

      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas: config.metadatas,
        layouts: { ...config.layouts, edit: nextEdit, list: nextList },
        options: config.options,
      });
      strapi.log.info(`[content-manager] hid relations from ${uid} layout`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to rewrite layout for ${uid}: ${err?.message ?? err}`
      );
    }
  }
}

// All site content is public; make sure the public role can read it so the
// static-site build and browser flows work on any fresh environment.
// Intentional: this re-grants on every boot, so revoking one of these read
// permissions in the admin UI will not stick across a restart — remove the
// action from this list instead. Same applies to ensureUploadSettings below.
const PUBLIC_READ_ACTIONS = [
  ...['store', 'brand', 'category', 'bank', 'tag', 'coupon', 'deal'].flatMap(
    (name) => [`api::${name}.${name}.find`, `api::${name}.${name}.findOne`]
  ),
  ...['homepage', 'global', 'menu', 'footer'].map(
    (name) => `api::${name}.${name}.find`
  ),
];

async function ensurePublicReadPermissions(strapi: Core.Strapi): Promise<void> {
  const publicRole = await strapi
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (!publicRole) {
    strapi.log.warn('[permissions] public role not found; skipping grant');
    return;
  }

  let granted = 0;
  for (const action of PUBLIC_READ_ACTIONS) {
    const existing = await strapi
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });

    if (!existing) {
      await strapi
        .query('plugin::users-permissions.permission')
        .create({ data: { action, role: publicRole.id } });
      granted += 1;
    }
  }

  if (granted > 0) {
    strapi.log.info(`[permissions] granted ${granted} public read permissions`);
  }
}

// Media Library settings live in the DB plugin store (not file config).
// Ensure responsive formats + optimization + orientation are on everywhere.
async function ensureUploadSettings(strapi: Core.Strapi): Promise<void> {
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

export default {
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await hideRelationsFromContentManager(strapi);
    await ensurePublicReadPermissions(strapi);
    await ensureUploadSettings(strapi);
  },
};
