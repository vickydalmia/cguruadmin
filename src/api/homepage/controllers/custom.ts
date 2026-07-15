import type { Core } from '@strapi/strapi';
import { arrayizeOfferText } from '../../../utils/offer-text';

// Aggregate endpoints for the static frontend build: one request returns the
// fully-populated homepage (5 levels deep — far beyond what REST populate
// query strings can sanely express) and one returns menu + footer + global.

const STORE_FIELDS = ['name', 'slug', 'shortDescription', 'logoAlt'];
const CATEGORY_FIELDS = ['name', 'slug', 'shortDescription'];
const BANK_FIELDS = ['name', 'slug', 'shortDescription', 'logoAlt'];
const BRAND_FIELDS = ['name', 'slug', 'shortDescription', 'logoAlt'];

// Relations in homepage components are curator-managed and therefore have no
// database-level cardinality bound. Constrain visibility/order in the query
// and cap the returned payload defensively below. Each section holds a +4
// buffer over what the site renders, so a mid-cycle expiry/delete never
// leaves a visible hole (the UI slices to its own display counts).
const MAX_LIST_ITEMS = 16;
const SECTION_LIST_CAPS = {
  popularStores: 24, // site shows 24
  topDeals: 10, // site shows 6
  dealsByBrand: 10, // legacy fallback, mirrors topDeals
  offersByBrand: 7, // site shows 3
  exploreOffersPerTab: 10, // site shows 6 per tab
  exploreDealsPerTab: 10, // legacy fallback, mirrors exploreOffers
} as const;
const PUBLISHED_OFFER_FILTER = { contentStatus: { $eq: 'published' } } as const;
const NEWEST_FIRST = ['publishedAt:desc'] as const;

// Never ship richtext `content` to the homepage payload.
const COUPON_FIELDS = [
  'title',
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
const DEAL_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'code',
  'salePrice',
  'mrp',
  'discount',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
];

const storeRef = { fields: STORE_FIELDS, populate: { logo: true } };
const categoryRef = { fields: CATEGORY_FIELDS, populate: { icon: true } };
const bankRef = { fields: BANK_FIELDS, populate: { logo: true } };
const brandRef = { fields: BRAND_FIELDS, populate: { logo: true } };

const couponRef = {
  fields: COUPON_FIELDS,
  populate: {
    image: true,
    stores: storeRef,
    brands: brandRef,
  },
};

const dealRef = {
  fields: DEAL_FIELDS,
  populate: {
    dealImage: true,
    primaryStore: storeRef,
    stores: storeRef,
    brands: brandRef,
  },
};

const publishedCouponRef = {
  ...couponRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const publishedDealRef = {
  ...dealRef,
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
  populate: { desktopImage: true, mobileImage: true },
};

const HOMEPAGE_POPULATE = {
  seo: { populate: { ogImage: true } },
  hero: {
    populate: {
      banners: bannerSlides,
      products: { populate: { deal: publishedDealRef, imageOverride: true } },
    },
  },
  topOffers: {
    populate: {
      viewAllCta: true,
      items: { populate: { coupon: publishedCouponRef, banner: true } },
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
    populate: { links: { populate: { store: storeRef, category: categoryRef } } },
  },
  latestInsights: { populate: { viewAllCta: true } },
} as const;

const MENU_POPULATE = {
  topStores: storeRef,
  categorySections: {
    populate: {
      category: categoryRef,
      links: { populate: { store: storeRef, category: categoryRef } },
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
} as const;

const GLOBAL_POPULATE = {
  telegramCta: true,
  newsletter: true,
} as const;

// Published AND not past its expiresAt: the populate filter only checks
// contentStatus, which the 5-minute cron may not have flipped yet.
const isLiveOffer = (offer: any, now: Date) =>
  offer?.contentStatus === 'published' &&
  (!offer.expiresAt || new Date(offer.expiresAt) > now);

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
const cap = (arr: any, limit: number = MAX_LIST_ITEMS) =>
  Array.isArray(arr) ? arr.slice(0, limit) : arr;

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

async function sanitizeOutput(strapi: Core.Strapi, ctx: any, uid: string, data: any): Promise<any> {
  const schema = strapi.contentType(uid as any) as any;
  return await strapi.contentAPI.sanitize.output(data, schema, { auth: ctx.state.auth });
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
      sanitizedMenu.topStores = cap(sanitizedMenu.topStores);
    }

    return ctx.send({
      menu: sanitizedMenu,
      footer: sanitizedFooter,
      global: sanitizedGlobal,
    });
  },
});
