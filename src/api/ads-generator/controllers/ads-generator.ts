import type { Core } from '@strapi/strapi';
import { adsGeneratorService } from '../../../ads-generator/ads-generator-service';

/**
 * Endpoints behind Settings → Ads Generator, for roles granted "Generate
 * Google Ads". Mounted on the ADMIN router (src/register/admin-routes.ts); the pipeline lives in
 * src/ads-generator/. Nothing is persisted: the CSV is returned in the response.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async options(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = adsGeneratorService(strapi.log).options();
  },
  async generate(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    const result = await adsGeneratorService(strapi.log).generate(ctx.request.body, String(ctx.state.user.id));
    ctx.status = result.status;
    ctx.body = result.body;
  },
});
