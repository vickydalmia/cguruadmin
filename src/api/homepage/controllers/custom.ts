import type { Core } from '@strapi/strapi';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import {
  backfillDeals,
  brandRef,
  cap,
  categoryRef,
  DEAL_FIELDS,
  dealRef,
  isLiveOffer,
  PUBLISHED_OFFER_FILTER,
  sanitizeOutput,
  storeRef,
} from '../../../utils/offer-visibility';

// Aggregate endpoints for the static frontend build: one request returns the
// fully-populated homepage (5 levels deep — far beyond what REST populate
// query strings can sanely express) and one returns menu + footer + global.


import {
  COUPON_FIELDS,
  MAX_TOP_STORES,
  FOOTER_POPULATE,
  GLOBAL_POPULATE,
  HEADER_NOTIFICATION_POPULATE,
  HOMEPAGE_POPULATE,
  MANAGED_SINGLE_ROUTES,
  MENU_POPULATE,
} from './homepage-populate';
import {
  attachOfferCounts,
  capCuratedLists,
  dropDeadOffers,
  fillTopDeals,
  headerNotificationPayload,
  routeMetadata,
} from './homepage-transforms';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async homepageFull(ctx) {
    // Homepage has draftAndPublish disabled — every entry is live; no status filter.
    const homepage = await strapi.documents('api::homepage.homepage').findFirst({
      populate: HOMEPAGE_POPULATE as any,
    });

    if (!homepage) {
      return ctx.notFound('Homepage not found');
    }

    const sanitized = await sanitizeOutput(strapi, ctx, 'api::homepage.homepage', homepage);
    dropDeadOffers(sanitized);
    await fillTopDeals(strapi, ctx, sanitized);
    capCuratedLists(sanitized);
    await attachOfferCounts(strapi, sanitized);
    // Nested Coupon cards emit offerText as words; Deal benefit labels and
    // computed pricing content are normalized by the same response walker.
    arrayizeOfferText(sanitized);
    // Resolves each offer's Checkout Merchant to its festive offer. Needs a
    // database read, so it cannot ride the synchronous walker above; it walks
    // the same nested section tree.
    await attachFestiveOffers(strapi, sanitized);

    return ctx.send({ data: sanitized });
  },

  async siteChrome(ctx) {
    const [menu, footer, global] = await Promise.all([
      strapi.documents('api::menu.menu').findFirst({ populate: MENU_POPULATE as any }),
      strapi.documents('api::footer.footer').findFirst({ populate: FOOTER_POPULATE as any }),
      strapi.documents('api::global.global').findFirst({ populate: GLOBAL_POPULATE as any }),
    ]);

    const [sanitizedMenu, sanitizedFooter, sanitizedGlobal] = await Promise.all([
      menu ? sanitizeOutput(strapi, ctx, 'api::menu.menu', menu) : null,
      footer ? sanitizeOutput(strapi, ctx, 'api::footer.footer', footer) : null,
      global ? sanitizeOutput(strapi, ctx, 'api::global.global', global) : null,
    ]);

    if (sanitizedMenu?.topStores) {
      sanitizedMenu.topStores = cap(sanitizedMenu.topStores, MAX_TOP_STORES);
    }
    if (sanitizedMenu?.searchTopStores) {
      sanitizedMenu.searchTopStores = cap(sanitizedMenu.searchTopStores, 8);
    }

    return ctx.send({
      menu: sanitizedMenu,
      footer: sanitizedFooter,
      global: sanitizedGlobal,
    });
  },

  async headerNotification(ctx) {
    const menu = await strapi.documents('api::menu.menu').findFirst({
      fields: ['documentId'] as any,
      populate: HEADER_NOTIFICATION_POPULATE as any,
    });
    if (!menu) return ctx.send({ data: [] });

    const sanitizedMenu = await sanitizeOutput(
      strapi,
      ctx,
      'api::menu.menu',
      menu,
    );
    return ctx.send({ data: headerNotificationPayload(sanitizedMenu) });
  },

  async publicRouteMetadata(ctx) {
    const [singleRows, jobs] = await Promise.all([
      Promise.all(
        MANAGED_SINGLE_ROUTES.map(([uid]) =>
          strapi.documents(uid as any).findFirst({
            fields: ['documentId', 'updatedAt'] as any,
            populate: {
              seo: { fields: ['noIndex'] },
            } as any,
          }),
        ),
      ),
      strapi.documents('api::job.job' as any).findMany({
        filters: { isActive: true } as any,
        fields: ['documentId', 'slug', 'updatedAt'] as any,
        populate: {
          seo: { fields: ['noIndex'] },
        } as any,
      }),
    ]);

    const pages = singleRows.flatMap((row, index) =>
      row ? [routeMetadata(MANAGED_SINGLE_ROUTES[index]![1], row)] : [],
    );
    const jobRoutes = (Array.isArray(jobs) ? jobs : []).flatMap((job: any) => {
      const slug = typeof job?.slug === 'string' ? job.slug.trim() : '';
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return [];
      return [routeMetadata(`/careers/${slug}/`, job)];
    });

    return ctx.send({ data: [...pages, ...jobRoutes] });
  },
});
