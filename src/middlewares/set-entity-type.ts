import type { Core } from '@strapi/strapi';

const ENTITY_MAP: Record<string, string> = {
  '/stores/': 'store',
  '/banks/': 'bank',
  '/categories/': 'category',
  '/brands/': 'brand',
};

export default (_config: unknown, { strapi: _strapi }: { strapi: Core.Strapi }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const path: string = ctx.path;

    for (const [segment, entityType] of Object.entries(ENTITY_MAP)) {
      if (path.includes(segment)) {
        ctx.state.entityType = entityType;
        break;
      }
    }

    await next();
  };
};
