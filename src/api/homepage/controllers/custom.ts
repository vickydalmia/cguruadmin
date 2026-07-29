import type { Core } from '@strapi/strapi';
import { arrayizeOfferText } from '../../../utils/offer-text';
import {
  backfillDeals,
  brandRef,
  cap,
  categoryRef,
  DEAL_FIELDS,
  dealRef,
  isLiveOffer,
  NEWEST_FIRST,
  PUBLISHED_OFFER_FILTER,
  sanitizeOutput,
  storeRef,
} from '../../../utils/offer-visibility';

// Aggregate endpoints for the static frontend build: one request returns the
// fully-populated homepage (5 levels deep — far beyond what REST populate
// query strings can sanely express) and one returns menu + footer + global.

const BANK_FIELDS = ['name', 'slug', 'shortDescription', 'logoAlt'];

// Relations in homepage components are curator-managed and therefore have no
// database-level cardinality bound. Constrain visibility/order in the query
// and cap the returned payload defensively below. Each section holds a +4
// buffer over what the site renders, so a mid-cycle expiry/delete never
// leaves a visible hole (the UI slices to its own display counts).
const MAX_LIST_ITEMS = 16;
const TOP_DEALS_RENDER_COUNT = 6;
const SECTION_LIST_CAPS = {
  popularStores: 24, // site shows 24
  topDeals: 10, // site shows 6
  dealsByBrand: 10, // legacy fallback, mirrors topDeals
  offersByBrand: 7, // site shows 3
  exploreOffersPerTab: 10, // site shows 6 per tab
  exploreDealsPerTab: 10, // legacy fallback, mirrors exploreOffers
} as const;
const COUPON_FIELDS = [
  'title',
  'content',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'code',
  'couponType',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
];

const bankRef = { fields: BANK_FIELDS, populate: { logo: true } };

const couponRef = {
  fields: COUPON_FIELDS,
  populate: {
    image: true,
    stores: storeRef,
    brands: brandRef,
    // The pool documentId (always emitted alongside the selected fields) is
    // what lets the frontend render the unique-code "Unlock Coupon" flow; the
    // allocated codes themselves stay behind /unique-coupon/redeem.
    uniqueCouponPool: { fields: ['name'] },
  },
};

// Hero products are compact linked merchandising tiles. They do not render
// expandable details, so keep their Deal payload free of unused rich text.
const heroDealRef = {
  ...dealRef,
  fields: DEAL_FIELDS.filter((field) => field !== 'content'),
};

// Top Offers are compact campaign tiles. Their Figma contract intentionally
// excludes details and validity, so do not ship unused rich text for them.
const topOfferCouponRef = {
  ...couponRef,
  fields: COUPON_FIELDS.filter((field) => field !== 'content'),
};

const publishedCouponRef = {
  ...couponRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const publishedDealRef = {
  ...dealRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const publishedHeroDealRef = {
  ...heroDealRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const publishedTopOfferCouponRef = {
  ...topOfferCouponRef,
  filters: PUBLISHED_OFFER_FILTER,
};

// Strapi's Document Service accepts nested filters and ordering here, but it
// rejects nested `limit`/pagination keys. The response-level cap below remains
// the compatibility-safe cardinality guard.
const publishedCouponListRef = {
  ...publishedCouponRef,
  sort: NEWEST_FIRST,
};

const publishedDealListRef = {
  ...publishedDealRef,
  sort: NEWEST_FIRST,
};

const bannerSlides = {
  populate: { desktopImage: true },
};

const HOMEPAGE_POPULATE = {
  seo: { populate: { ogImage: true } },
  hero: {
    populate: {
      banners: bannerSlides,
      products: { populate: { deal: publishedHeroDealRef, imageOverride: true } },
    },
  },
  topOffers: {
    populate: {
      viewAllCta: true,
      items: { populate: { coupon: publishedTopOfferCouponRef, banner: true } },
    },
  },
  popularStores: {
    populate: { viewAllCta: true, featuredStore: storeRef, stores: storeRef },
  },
  topDeals: { populate: { viewAllCta: true, deals: publishedDealListRef } },
  cgExclusive: {
    populate: {
      viewAllCta: true,
      items: { populate: { coupon: publishedCouponRef, bannerOverride: true } },
    },
  },
  exploreDeals: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          category: categoryRef,
          deals: publishedDealListRef,
        },
      },
    },
  },
  exploreOffers: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          category: categoryRef,
          offers: publishedCouponListRef,
        },
      },
    },
  },
  newlyAdded: {
    populate: {
      viewAllCta: true,
      items: { populate: { coupon: publishedCouponRef, cardImage: true } },
    },
  },
  dealsByBrand: { populate: { viewAllCta: true, deals: publishedDealListRef } },
  offersByBrand: { populate: { viewAllCta: true, offers: publishedCouponListRef } },
  bankOffers: { populate: { viewAllCta: true, items: { populate: { bank: bankRef } } } },
  howItWorks: { populate: { steps: true, features: true } },
  faq: { populate: { items: true } },
  popularSearches: {
    populate: {
      stores: { fields: ['name', 'slug'] },
      brands: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
      banks: { fields: ['name', 'slug'] },
    },
  },
  latestInsights: { populate: { viewAllCta: true } },
} as const;

const MENU_POPULATE = {
  topStores: storeRef,
  searchTopStores: { populate: { store: storeRef } },
  searchSuggestions: true,
  categorySections: {
    populate: {
      icon: true,
      category: categoryRef,
      links: { populate: { icon: true, store: storeRef, category: categoryRef } },
    },
  },
  extraItems: { populate: { store: storeRef, category: categoryRef } },
} as const;

const FOOTER_POPULATE = {
  sections: {
    populate: { links: { populate: { store: storeRef, category: categoryRef } } },
  },
  socialLinks: true,
  countries: { populate: { flag: true } },
  partnerCard: true,
  googlePreferredCard: { populate: { icon: true } },
} as const;

const GLOBAL_POPULATE = {
  telegramCta: true,
  newsletter: true,
} as const;

const HEADER_NOTIFICATION_POPULATE = {
  notification: {
    populate: {
      coupon: {
        populate: {
          imageOverride: true,
          coupon: {
            fields: ['title', 'contentStatus', 'expiresAt'],
            populate: {
              image: true,
              stores: storeRef,
              brands: brandRef,
              categories: categoryRef,
              banks: bankRef,
            },
          },
        },
      },
      productDeal: {
        populate: {
          imageOverride: true,
          productDeal: {
            fields: ['title', 'contentStatus', 'expiresAt'],
            populate: { dealImage: true },
          },
        },
      },
    },
  },
} as const;

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstCouponImage(coupon: any): any {
  if (coupon?.image?.url) return coupon.image;
  const candidates = [
    ...(coupon?.stores ?? []).map((item: any) => item?.logo),
    ...(coupon?.brands ?? []).map((item: any) => item?.logo),
    ...(coupon?.banks ?? []).map((item: any) => item?.logo),
    ...(coupon?.categories ?? []).map((item: any) => item?.icon),
  ];
  return candidates.find((media: any) => nonBlank(media?.url)) ?? null;
}

function notificationItem(
  kind: 'coupon' | 'deal',
  config: any,
  now: Date,
) {
  const target = kind === 'coupon' ? config?.coupon : config?.productDeal;
  if (!isLiveOffer(target, now)) return null;

  const targetId = Number(target?.id);
  const title =
    nonBlank(config?.titleOverride) ?? nonBlank(target?.title);
  const image =
    config?.imageOverride?.url
      ? config.imageOverride
      : kind === 'coupon'
        ? firstCouponImage(target)
        : target?.dealImage;

  if (
    !Number.isSafeInteger(targetId) ||
    targetId <= 0 ||
    !title ||
    !nonBlank(image?.url)
  ) {
    return null;
  }

  return { kind, targetId, title, image };
}

function headerNotificationPayload(menu: any, now = new Date()) {
  return [
    notificationItem('coupon', menu?.notification?.coupon, now),
    notificationItem('deal', menu?.notification?.productDeal, now),
  ].filter(Boolean);
}

// Homepage components reference coupons/deals directly, which bypasses the
// contentStatus visibility filter used by the list endpoints — strip anything
// that isn't live before the payload leaves the API. Card-wrapper items
// (hero/topOffers/cgExclusive/newlyAdded) carry their own copied image and
// override text, so an item whose relation resolved to null (deleted, or
// filtered out by the populate as expired/scheduled) must be dropped too —
// otherwise the card renders with a dead offer behind it.
function dropDeadOffers(homepage: any) {
  if (!homepage) return homepage;
  const now = new Date();
  const live = (offer: any) => isLiveOffer(offer, now);

  if (homepage.hero?.products) {
    homepage.hero.products = homepage.hero.products.filter((p: any) => live(p.deal));
  }
  for (const key of ['topOffers', 'cgExclusive', 'newlyAdded']) {
    const section = homepage[key];
    if (section?.items) {
      section.items = section.items.filter((i: any) => live(i.coupon));
    }
  }
  if (homepage.bankOffers?.items) {
    homepage.bankOffers.items = homepage.bankOffers.items.filter((i: any) => i.bank);
  }
  if (homepage.offersByBrand?.offers) {
    homepage.offersByBrand.offers = homepage.offersByBrand.offers.filter(live);
  }
  if (homepage.exploreOffers?.tabs) {
    for (const tab of homepage.exploreOffers.tabs) {
      if (tab?.offers) {
        tab.offers = tab.offers.filter(live);
      }
    }
  }
  for (const key of ['topDeals', 'dealsByBrand']) {
    const section = homepage[key];
    if (section?.deals) {
      section.deals = section.deals.filter(live);
    }
  }
  if (homepage.exploreDeals?.tabs) {
    for (const tab of homepage.exploreDeals.tabs) {
      if (tab?.deals) {
        tab.deals = tab.deals.filter(live);
      }
    }
  }
  return homepage;
}

// The curated store/deal lists are unbounded oneToMany relations (schema
// `max` only exists for repeatable components), so cap them here — per
// section — to keep the payload and the per-store count queries bounded no
// matter what an admin attaches in the CMS. Runs after dropDeadOffers, so
// the caps count only live offers.
function capCuratedLists(homepage: any) {
  if (!homepage) return homepage;

  if (homepage.popularStores?.stores) {
    homepage.popularStores.stores = cap(
      homepage.popularStores.stores,
      SECTION_LIST_CAPS.popularStores,
    );
  }
  for (const key of ['topDeals', 'dealsByBrand'] as const) {
    const section = homepage[key];
    if (section?.deals) {
      section.deals = cap(section.deals, SECTION_LIST_CAPS[key]);
    }
  }
  if (homepage.exploreDeals?.tabs) {
    for (const tab of homepage.exploreDeals.tabs) {
      if (tab?.deals) {
        tab.deals = cap(tab.deals, SECTION_LIST_CAPS.exploreDealsPerTab);
      }
    }
  }
  if (homepage.offersByBrand?.offers) {
    homepage.offersByBrand.offers = cap(
      homepage.offersByBrand.offers,
      SECTION_LIST_CAPS.offersByBrand,
    );
  }
  if (homepage.exploreOffers?.tabs) {
    for (const tab of homepage.exploreOffers.tabs) {
      if (tab?.offers) {
        tab.offers = cap(tab.offers, SECTION_LIST_CAPS.exploreOffersPerTab);
      }
    }
  }
  return homepage;
}

// Legacy imports can violate today's required Deal fields. Keep every valid
// curated Top Deal in editor order, then fill the remaining visible slots
// from recent Deal-schema records. Coupon records never enter this section.
// The site treats only an explicit `enabled: false` as a disable (legacy
// entries saved without the flag still render) — gate backfill the same way.
async function fillTopDeals(
  strapi: Core.Strapi,
  ctx: any,
  homepage: any,
) {
  const section = homepage?.topDeals;
  if (!section || section.enabled === false) return homepage;

  await backfillDeals(strapi, ctx, section, {
    filters: {},
    renderCount: TOP_DEALS_RENDER_COUNT,
    capLimit: SECTION_LIST_CAPS.topDeals,
    now: new Date(),
  });

  return homepage;
}

async function countOffersForStore(strapi: Core.Strapi, documentId: string) {
  const filters = {
    stores: { documentId },
    contentStatus: { $eq: 'published' },
  } as any;
  const [coupons, deals] = await Promise.all([
    strapi.documents('api::coupon.coupon').count({ filters }),
    strapi.documents('api::deal.deal').count({ filters }),
  ]);
  return coupons + deals;
}

// Attach a computed offerCount to every store in the popularStores section.
// Computed (not stored) so m2m edits and cron status flips can never drift.
async function attachOfferCounts(strapi: Core.Strapi, homepage: any) {
  const section = homepage?.popularStores;
  if (!section) return homepage;

  const stores = [section.featuredStore, ...(section.stores ?? [])].filter(Boolean);
  const uniqueIds = [...new Set(stores.map((s: any) => s.documentId))] as string[];
  const counts = await Promise.all(
    uniqueIds.map(async (id) => [id, await countOffersForStore(strapi, id)] as const),
  );
  const byId = new Map(counts);
  for (const store of stores) {
    store.offerCount = byId.get(store.documentId) ?? 0;
  }
  return homepage;
}

const MANAGED_SINGLE_ROUTES = [
  ['api::homepage.homepage', '/'],
  ['api::about-page.about-page', '/about-us/'],
  ['api::career-page.career-page', '/careers/'],
  [
    'api::deal-of-the-day-page.deal-of-the-day-page',
    '/deal-of-the-day/',
  ],
] as const;

function routeMetadata(path: string, row: any) {
  const updatedAt =
    row?.updatedAt instanceof Date
      ? row.updatedAt.toISOString()
      : typeof row?.updatedAt === 'string'
        ? row.updatedAt
        : undefined;
  return {
    path,
    ...(updatedAt ? { updatedAt } : {}),
    noIndex: row?.seo?.noIndex === true,
  };
}

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
    // Nested coupon/deal cards: emit offerText as an array of words.
    arrayizeOfferText(sanitized);

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
      sanitizedMenu.topStores = cap(sanitizedMenu.topStores, MAX_LIST_ITEMS);
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
