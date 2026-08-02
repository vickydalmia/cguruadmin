import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

// One request supplies the complete public document. The gallery filters and
// "Load more" are entirely client-side over the rendered HTML, so no query
// string changes this aggregate or its cache key.
export const CULTURE_PAGE_POPULATE = {
  breadcrumbItems: true,
  hero: { populate: { image: true } },
  stats: true,
  values: { populate: { header: true, cards: true } },
  gallery: {
    populate: {
      header: true,
      categories: true,
      photos: { populate: { image: true } },
    },
  },
  testimonials: {
    populate: { header: true, items: { populate: { avatar: true } } },
  },
  journey: { populate: { header: true, milestones: true } },
  recruitment: { populate: { image: true } },
  seo: { populate: { ogImage: true } },
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async culturePageFull(ctx: any) {
    const page = await strapi
      .documents('api::culture-page.culture-page' as any)
      .findFirst({ populate: CULTURE_PAGE_POPULATE as any });

    // The route is code-owned and has a complete committed fallback. A missing
    // single type is therefore valid page data, not a missing public document.
    if (!page) {
      return ctx.send({ data: null });
    }

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::culture-page.culture-page',
      page,
    );

    return ctx.send({ data: sanitized });
  },
});
