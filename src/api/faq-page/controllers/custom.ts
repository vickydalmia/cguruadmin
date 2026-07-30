import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

// One request supplies the complete public document. Search remains entirely
// client-side, so no query string changes this aggregate or its cache key.
export const FAQ_PAGE_POPULATE = {
  breadcrumbItems: true,
  categories: {
    populate: {
      items: true,
    },
  },
  supportCta: {
    populate: {
      action: true,
    },
  },
  seo: {
    populate: {
      ogImage: true,
    },
  },
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async faqPageFull(ctx: any) {
    const page = await strapi
      .documents('api::faq-page.faq-page' as any)
      .findFirst({ populate: FAQ_PAGE_POPULATE as any });

    // The route is code-owned and has a complete committed fallback. A missing
    // single type is therefore valid page data, not a missing public document.
    if (!page) {
      return ctx.send({ data: null });
    }

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::faq-page.faq-page',
      page,
    );

    return ctx.send({ data: sanitized });
  },
});
