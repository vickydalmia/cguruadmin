import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

export const CONTACT_PAGE_POPULATE = {
  breadcrumbItems: true,
  hero: {
    populate: {
      image: true,
    },
  },
  contactMethods: true,
  form: {
    populate: {
      topics: true,
    },
  },
  seo: {
    populate: {
      ogImage: true,
    },
  },
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async contactPageFull(ctx: any) {
    const page = await strapi
      .documents('api::contact-page.contact-page' as any)
      .findFirst({ populate: CONTACT_PAGE_POPULATE as any });

    // The frontend owns a complete, committed Figma fallback. A single type
    // that has not been saved yet is therefore valid data rather than a 404.
    if (!page) return ctx.send({ data: null });

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::contact-page.contact-page',
      page,
    );

    return ctx.send({ data: sanitized });
  },
});
