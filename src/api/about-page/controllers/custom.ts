import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

// Aggregate endpoint for the public /about-us/ page: one request returns every
// section fully populated, mirroring the homepage-full and deal-of-the-day-full
// contract. The page is purely editorial — it references no Coupon or Deal
// records, so none of the offer-visibility filtering applies here.

// The country list rendered by the International Presence section is NOT part
// of this payload. It lives on the Footer single type so the footer and this
// section can never disagree; the site reads it through getFooter().
const ABOUT_POPULATE = {
  seo: { populate: { ogImage: true } },
  breadcrumbItems: true,
  hero: { populate: { image: true } },
  ourStory: { populate: { header: true, paragraphs: true, image: true } },
  journey: { populate: { header: true, milestones: true } },
  missionVision: { populate: { header: true, pillars: true, stats: true } },
  trust: { populate: { header: true, paragraphs: true, cards: true } },
  founder: { populate: { paragraphs: true, portrait: true } },
  press: { populate: { header: true, logos: { populate: { image: true } } } },
  international: { populate: { header: true } },
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async aboutPageFull(ctx) {
    // The single type has draftAndPublish disabled — the entry is live once
    // saved; findFirst returns null until an admin creates it.
    const page = await strapi
      .documents('api::about-page.about-page')
      .findFirst({ populate: ABOUT_POPULATE as any });

    if (!page) {
      return ctx.notFound('About page not found');
    }

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::about-page.about-page',
      page,
    );

    return ctx.send({ data: sanitized });
  },
});
