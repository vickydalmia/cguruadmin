import type { Core } from '@strapi/strapi';

import { filterContentManagerInitBody } from '../api/site-configuration/services/admin-content-visibility';

/**
 * Content Manager builds its sidebar from GET /content-manager/init. Filter
 * that response at request time so every Strapi process reads the deployment's
 * current Country Setup instead of relying on build-time values or process
 * memory changed by a different container.
 */
export default (
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
) => {
  return async (ctx: any, next: () => Promise<void>) => {
    await next();

    if (ctx.method !== 'GET') return;
    if (!/\/content-manager\/init\/?$/u.test(ctx.path)) return;
    if (ctx.status < 200 || ctx.status >= 300) return;

    try {
      ctx.body = await filterContentManagerInitBody(strapi, ctx.body);
    } catch (error: any) {
      // Admin navigation must remain usable if the configuration query fails.
      // Public feature gates remain fail-closed independently.
      strapi.log.error(
        `[country-setup] Content Manager visibility filter failed: ${error?.message ?? error}`,
      );
    }
  };
};
