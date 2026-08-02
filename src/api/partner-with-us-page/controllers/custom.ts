import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

export const PARTNER_WITH_US_PAGE_POPULATE = {
  breadcrumbItems: true,
  hero: { populate: { image: true } },
  trusted: { populate: { logos: { populate: { image: true } } } },
  benefits: { populate: { items: true } },
  impact: { populate: { stats: true } },
  exposure: {
    populate: {
      pillars: { populate: { items: true } },
      banner: true,
    },
  },
  partnerships: { populate: { items: true } },
  support: { populate: { items: true } },
  cta: true,
  seo: { populate: { ogImage: true } },
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async partnerWithUsPageFull(ctx: any) {
    const page = await strapi
      .documents('api::partner-with-us-page.partner-with-us-page' as any)
      .findFirst({ populate: PARTNER_WITH_US_PAGE_POPULATE as any });

    if (!page) return ctx.send({ data: null });

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::partner-with-us-page.partner-with-us-page',
      page,
    );
    return ctx.send({ data: sanitized });
  },
});
