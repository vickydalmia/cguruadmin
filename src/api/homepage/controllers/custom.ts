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
import { featureByPath } from '../../site-configuration/services/country-registry';
import { filterSiteChrome } from '../../site-configuration/services/site-chrome-filter';
import { filterHomepage } from '../../site-configuration/services/homepage-filter';
import { findEntityTemplateOwners } from '../../site-configuration/services/entity-template-owners';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async homepageFull(ctx) {
    // Homepage has draftAndPublish disabled — every entry is live; no status filter.
    const [homepage, siteSettings] = await Promise.all([
      strapi.documents('api::homepage.homepage').findFirst({
        populate: HOMEPAGE_POPULATE as any,
      }),
      (strapi.service('api::site-configuration.site-configuration') as any).publicSettings(),
    ]);

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
    filterHomepage(sanitized, siteSettings.features);

    return ctx.send({ data: sanitized, siteSettings });
  },

  async siteChrome(ctx) {
    const [menu, footer, global, siteSettings] = await Promise.all([
      strapi.documents('api::menu.menu').findFirst({ populate: MENU_POPULATE as any }),
      strapi.documents('api::footer.footer').findFirst({ populate: FOOTER_POPULATE as any }),
      strapi.documents('api::global.global').findFirst({ populate: GLOBAL_POPULATE as any }),
      (strapi.service('api::site-configuration.site-configuration') as any).publicSettings(),
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

    const filtered = filterSiteChrome(
      sanitizedMenu,
      sanitizedFooter,
      siteSettings.features,
    );

    return ctx.send({
      menu: filtered.menu,
      footer: filtered.footer,
      global: sanitizedGlobal,
      siteSettings,
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
    const siteSettings = await (
      strapi.service('api::site-configuration.site-configuration') as any
    ).publicSettings();
    const liveManagedRoutes = MANAGED_SINGLE_ROUTES.filter(([, path]) => {
      if (path === '/') return true;
      const feature = featureByPath(path);
      return feature ? siteSettings.features[feature.key]?.live === true : true;
    });
    const careersLive = siteSettings.features.careers?.live === true;
    const [singleRows, jobs, campaignPages] = await Promise.all([
      Promise.all(
        liveManagedRoutes.map(([uid]) =>
          strapi.documents(uid as any).findFirst({
            fields: ['documentId', 'updatedAt'] as any,
            populate: {
              seo: { fields: ['noIndex'] },
            } as any,
          }),
        ),
      ),
      careersLive ? strapi.documents('api::job.job' as any).findMany({
        filters: { isActive: true } as any,
        fields: ['documentId', 'slug', 'updatedAt'] as any,
        populate: {
          seo: { fields: ['noIndex'] },
        } as any,
      }) : Promise.resolve([]),
      Promise.all([
        ['dealOfTheDay', 'dealTemplate', 'api::deal-of-the-day-page.deal-of-the-day-page'],
        ['independenceDaySale', 'independenceDayTemplate', 'api::independence-day-sale-page.independence-day-sale-page'],
      ].map(async ([featureKey, pageTemplate, uid]) => {
        if (siteSettings.features[featureKey]?.live !== true) return [];
        const [owners, singleton]: [any[], any] = await Promise.all([
          findEntityTemplateOwners(strapi, pageTemplate as any),
          strapi.documents(uid as any).findFirst({
            fields: ['documentId', 'updatedAt'] as any,
            populate: { seo: { fields: ['noIndex'] } } as any,
          }),
        ]);
        if (!singleton) return [];
        // Only the first (authoritative) owner renders the campaign template —
        // any accidental duplicate falls back to its generic entity page, so
        // it must not inherit the singleton's route metadata.
        return owners.slice(0, 1).map((owner) => {
          const timestamps = [owner.updatedAt, singleton.updatedAt]
            .map((value) => new Date(value ?? 0))
            .filter((value) => Number.isFinite(value.getTime()));
          const updatedAt = timestamps.length > 0
            ? new Date(Math.max(...timestamps.map((value) => value.getTime()))).toISOString()
            : undefined;
          return routeMetadata(`/${owner.slug}/`, {
            ...singleton,
            updatedAt,
          });
        });
      })),
    ]);

    const pages = singleRows.flatMap((row, index) =>
      row ? [routeMetadata(liveManagedRoutes[index]![1], row)] : [],
    );
    const jobRoutes = (Array.isArray(jobs) ? jobs : []).flatMap((job: any) => {
      const slug = typeof job?.slug === 'string' ? job.slug.trim() : '';
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return [];
      return [routeMetadata(`/careers/${slug}/`, job)];
    });

    return ctx.send({ data: [...pages, ...jobRoutes, ...campaignPages.flat()] });
  },
});
