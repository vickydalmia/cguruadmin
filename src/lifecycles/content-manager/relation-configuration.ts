import type { Core } from '@strapi/strapi';

import { moveEditLayoutFieldAfter } from '../../utils/content-manager-layout';
import {
  ensureAdminRelationSearchFieldsForUid,
  getAdminRelationSearchFields,
  groupAdminRelationSearchFields,
} from '../../utils/content-manager-relation-search';

// Native relation search reads mainField from the SOURCE component relation
// metadata. This configuration is strictly for Content Manager: it changes
// which visible text Admin searches and never touches public query filters,
// relation data, or ISR.
export async function ensureAdminRelationSearchFields(
  strapi: Core.Strapi
): Promise<void> {
  const grouped = groupAdminRelationSearchFields(
    getAdminRelationSearchFields(strapi)
  );
  const failed: string[] = [];

  for (const [uid, fields] of grouped) {
    try {
      const ok = await ensureAdminRelationSearchFieldsForUid(
        strapi,
        uid,
        fields
      );
      if (!ok) failed.push(uid);
    } catch (err: any) {
      strapi.log.error(
        `[content-manager] admin relation search for ${uid} failed: ${err?.message ?? err}`
      );
      failed.push(uid);
    }
  }

  if (failed.length > 0) {
    strapi.log.error(
      `[content-manager] admin relation search configuration failed for `
      + `${failed.join(', ')} — title search in these pickers may fall back to IDs`
    );
  }
}

// A role whose Content Manager read permission on a picker target omits the
// searched text field makes Strapi silently search documentId instead — title
// search then never matches for users of that role only. Surface it at boot;
// never auto-grant (permission seeding elsewhere in this file is deliberate).
export async function ensureRelationTargetFieldReadability(
  strapi: Core.Strapi
): Promise<void> {
  const mainFieldByTarget = new Map<string, string>();
  for (const { targetUid, mainField } of getAdminRelationSearchFields(strapi)) {
    mainFieldByTarget.set(targetUid, mainField);
  }
  if (mainFieldByTarget.size === 0) return;

  try {
    const [permissions, roles]: [any[], any[]] = await Promise.all([
      strapi.db.query('admin::permission').findMany({
        where: {
          action: 'plugin::content-manager.explorer.read',
          subject: { $in: [...mainFieldByTarget.keys()] },
        },
        populate: ['role'],
      }),
      strapi.db.query('admin::role').findMany({
        where: { code: { $ne: 'strapi-super-admin' } },
      }),
    ]);

    for (const role of roles) {
      for (const [subject, mainField] of mainFieldByTarget) {
        const rolePermissions = permissions.filter(
          (permission) =>
            permission.subject === subject && permission.role?.id === role.id
        );
        const canReadMainField = rolePermissions.some((permission) => {
          const fields = permission.properties?.fields;
          return !Array.isArray(fields) || fields.includes(mainField);
        });
        if (canReadMainField) continue;

        strapi.log.error(
          `[permissions] role "${role.code}" cannot read ${subject}.${mainField} — `
          + `relation pickers targeting it will silently search documentId for `
          + `these users`
        );
      }
    }
  } catch (err: any) {
    strapi.log.error(
      `[permissions] relation search readability check failed: ${err?.message ?? err}`
    );
  }
}

// Category Section already has an icon field, but its persisted layout placed
// it below the large repeatable Links editor. Keep the same field and move it
// directly below Category so the override is discoverable.
export async function ensureNavigationIconPlacement(
  strapi: Core.Strapi
): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  try {
    const component = service.findComponent('nav.category-section');
    if (!component) return;
    const config = await service.findConfiguration(component);
    const edit = moveEditLayoutFieldAfter(
      config.layouts?.edit ?? [],
      'icon',
      'category',
    );
    if (!edit) return;

    await service.updateConfiguration(component, {
      ...config,
      layouts: { ...config.layouts, edit },
    });
    strapi.log.info(
      '[content-manager] navigation Category icon placed below Category'
    );
  } catch (err: any) {
    strapi.log.warn(
      `[content-manager] navigation icon placement failed: ${err?.message ?? err}`
    );
  }
}
