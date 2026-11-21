import type { Core } from '@strapi/strapi';
import { adsGeneratorService } from '../../../ads-generator/ads-generator-service';

/**
 * Endpoints behind Settings → Ads Generator, for roles granted "Generate
 * Google Ads". Mounted on the ADMIN router (src/register/admin-routes.ts);
 * the pipeline lives in src/ads-generator/. POST /generate starts a
 * background job (202) and GET /jobs/:id polls it. Nothing is persisted.
 */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async options(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = adsGeneratorService(strapi.log).options();
  },
  async generate(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    const result = adsGeneratorService(strapi.log).generate(ctx.request.body, String(ctx.state.user.id));
    ctx.status = result.status;
    ctx.body = result.body;
  },
  async job(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    const id = String(ctx.params.id ?? '');
    if (!JOB_ID.test(id)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid job id.' };
      return;
    }
    const result = adsGeneratorService(strapi.log).job(id, String(ctx.state.user.id));
    ctx.status = result.status;
    ctx.body = result.body;
  },
});
