import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

export const TESTIMONIALS_PAGE_POPULATE = {
  breadcrumbItems: true,
  hero: true,
  featured: {
    populate: {
      slides: { populate: { avatar: true } },
    },
  },
  partners: {
    populate: {
      testimonials: { populate: { avatar: true } },
    },
  },
  partnerCta: true,
  faq: { populate: { items: true } },
  seo: { populate: { ogImage: true } },
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async testimonialsPageFull(ctx: any) {
    const page = await strapi
      .documents('api::testimonials-page.testimonials-page' as any)
      .findFirst({ populate: TESTIMONIALS_PAGE_POPULATE as any });

    if (!page) return ctx.send({ data: null });

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::testimonials-page.testimonials-page',
      page,
    );
    return ctx.send({ data: sanitized });
  },
});
