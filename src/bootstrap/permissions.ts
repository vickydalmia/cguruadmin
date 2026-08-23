import type { Core } from '@strapi/strapi';
import { ENTITY_COUPON_LAYOUT_ACTION } from '../api/entity-coupon-layout/services/entity-coupon-layout';

// All site content is public; make sure the public role can read it so the
// static-site build and browser flows work on any fresh environment.
// Intentional: this re-grants on every boot, so revoking one of these read
// permissions in the admin UI will not stick across a restart — remove the
// action from this list instead. Same applies to ensureUploadSettings
// (src/bootstrap/upload.ts).
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

// Seed only once. The marker intentionally survives later manual
// revocation, so a boot never grants this permission back behind an
// administrator's back.
//
// The marker key is versioned because the action used to be registered in
// the bootstrap lifecycle, which silently deleted the granted row on every
// boot (see the registration site in src/index.ts `register` for why).
// Databases seeded under the old key hold the marker but no permission, so
// they would never be re-seeded. Bumping the key re-seeds each of them
// exactly once.
export async function seedEditorCouponLayoutPermission(strapi: Core.Strapi): Promise<void> {
  try {
    const store = strapi.store({
      type: 'plugin',
      name: 'entity-coupon-layout',
    });
    const seeded = await store.get({ key: 'editor-permission-seeded-v2' });
    if (!seeded) {
      const editor = await strapi.db.query('admin::role').findOne({
        where: { code: 'strapi-editor' },
        select: ['id'],
      });
      if (editor) {
        const existing = await strapi.db.query('admin::permission').findOne({
          where: {
            role: editor.id,
            action: ENTITY_COUPON_LAYOUT_ACTION,
          },
          select: ['id'],
        });
        if (!existing) {
          await strapi.db.query('admin::permission').create({
            data: {
              action: ENTITY_COUPON_LAYOUT_ACTION,
              subject: null,
              properties: {},
              conditions: [],
              role: editor.id,
            },
          });
        }
      }
      await store.set({
        key: 'editor-permission-seeded-v2',
        value: true,
      });
    }
  } catch (err: any) {
    strapi.log.warn(
      `[permissions] entity Coupon layout Editor seed failed: ${err?.message ?? err}`,
    );
  }
}
