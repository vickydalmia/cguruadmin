import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async search(ctx) {
    const service = strapi.service('api::search.search') as any;
    const parsed = service.parseRequest(ctx.query ?? {});
    if (!parsed.ok) return ctx.badRequest(parsed.message);
    return ctx.send(await service.search(parsed.value));
  },
});
