import type { Core } from '@strapi/strapi';

// All site content is public; make sure the public role can read it so the
// static-site build and browser flows work on any fresh environment.
// Intentional: this re-grants on every boot, so revoking one of these read
// permissions in the admin UI will not stick across a restart — remove the
// action from this list instead. Same applies to ensureUploadSettings below.
// coupon/deal are intentionally excluded: their core routes are disabled and
// the public frontend reads offers only through the custom controllers, which
// control populate and never expose the unique-code pool.
const PUBLIC_READ_ACTIONS = [
  ...['store', 'brand', 'category', 'bank'].flatMap(
    (name) => [`api::${name}.${name}.find`, `api::${name}.${name}.findOne`]
  ),
  ...['homepage', 'global', 'menu', 'footer', 'error-page', 'career-page'].map(
    (name) => `api::${name}.${name}.find`
  ),
  'api::job.job.find',
  'api::job.job.findOne',
  // The storefront middleware reads the active redirect map on every request.
  // Without this the fetch 403s and get-redirects fails open to an empty
  // table, so every authored redirect silently stops firing.
  'api::redirect.redirect.find',
];

export async function ensurePublicReadPermissions(strapi: Core.Strapi): Promise<void> {
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

// Single types only Super Admin may manage. Footer & Global Settings drive the
// whole site's chrome, so a stray edit is high-blast-radius (QC: restrict to
// Super Admin). Enforced as config-as-code: every boot strips the
// content-manager (explorer) permissions for these subjects from every
// non-super-admin admin role, so re-granting them in the Roles UI will not
// stick — the same stance as ensurePublicReadPermissions above. Super Admin
// bypasses permission checks entirely, so it always keeps access.
const SUPER_ADMIN_ONLY_SUBJECTS = ['api::footer.footer', 'api::global.global'];

export async function restrictSingleTypesToSuperAdmin(strapi: Core.Strapi): Promise<void> {
  try {
    const roles = await strapi.db.query('admin::role').findMany({ select: ['id', 'code'] });
    let removed = 0;
    for (const role of roles) {
      if (role.code === 'strapi-super-admin') continue;
      const perms = await strapi.db.query('admin::permission').findMany({
        where: { role: role.id, subject: { $in: SUPER_ADMIN_ONLY_SUBJECTS } },
        select: ['id', 'action'],
      });
      const ids = perms
        .filter((p: any) => String(p.action).startsWith('plugin::content-manager.explorer'))
        .map((p: any) => p.id);
      if (ids.length) {
        await strapi.db.query('admin::permission').deleteMany({ where: { id: { $in: ids } } });
        removed += ids.length;
      }
    }
    if (removed > 0) {
      strapi.log.info(
        `[permissions] removed ${removed} Footer/Global permission(s) from non-super-admin roles`
      );
    }
  } catch (err: any) {
    strapi.log.warn(`[permissions] super-admin lock failed: ${err?.message ?? err}`);
  }
}
