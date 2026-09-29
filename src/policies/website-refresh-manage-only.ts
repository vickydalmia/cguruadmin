import type { Core } from '@strapi/strapi';
import { WEBSITE_REFRESH_ACTION } from '../api/website-refresh/controllers/website-refresh';
import { adminHasRbacAction } from '../utils/admin-rbac-action';
export default (ctx: any, _config: unknown, { strapi }: { strapi: Core.Strapi }) =>
  adminHasRbacAction(strapi, ctx, WEBSITE_REFRESH_ACTION);
