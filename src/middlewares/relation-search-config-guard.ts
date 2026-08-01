import type { Core } from '@strapi/strapi';
import {
  ensureAdminRelationSearchFieldsForUid,
  getAdminRelationSearchFields,
  groupAdminRelationSearchFields,
} from '../utils/content-manager-relation-search';

/**
 * Saving "Configure the view" replaces a component's whole Content Manager
 * configuration, which is the one runtime path that can wipe the pinned
 * relation-search mainField until the next boot. Re-assert it right after a
 * successful save. If Strapi ever renames this route the guard no-ops and the
 * bootstrap pinning remains the safety net.
 */
export default (
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
) => {
  return async (ctx: any, next: () => Promise<void>) => {
    await next();

    if (ctx.method !== 'PUT') return;
    if (ctx.status < 200 || ctx.status >= 300) return;

    const match = ctx.path.match(
      /\/content-manager\/components\/([^/]+)\/configuration\/?$/,
    );
    if (!match) return;

    const uid = decodeURIComponent(match[1]);
    const fields = groupAdminRelationSearchFields(
      getAdminRelationSearchFields(strapi),
    ).get(uid);
    if (!fields) return;

    try {
      await ensureAdminRelationSearchFieldsForUid(strapi, uid, fields);
    } catch (err: any) {
      strapi.log.error(
        `[content-manager] relation search re-assert for ${uid} failed: ${err?.message ?? err}`,
      );
    }
  };
};
