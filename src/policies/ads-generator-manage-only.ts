import type { Core } from '@strapi/strapi';
import { ADS_GENERATOR_ACTION } from '../constants/ads-generator';
import { adminHasRbacAction } from '../utils/admin-rbac-action';

/**
 * Gate for the Ads Generator endpoints (paid OpenAI work). The decision is the
 * assignable `ads-generator.generate` RBAC action, granted per role in
 * Settings → Roles. Super Admins pass by construction. Only sound on an
 * admin-type route; the helper fails closed on any other auth strategy.
 */
export default (ctx: any, _config: unknown, { strapi }: { strapi: Core.Strapi }) =>
  adminHasRbacAction(strapi, ctx, ADS_GENERATOR_ACTION);
