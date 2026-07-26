import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getSitemapEntities(ctx) {
    const service = strapi.service('api::sitemap.sitemap') as any;
    const data = await service.listSitemapEntities();
    return ctx.send({ data });
  },
});
