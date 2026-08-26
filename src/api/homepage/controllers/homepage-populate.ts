// Homepage POPULATE/QUERY DEFINITIONS: the deep populate trees, list caps,
// field projections and the managed single-type route table. Split out of
// ./custom.ts, which keeps the load -> sanitize -> transform -> send flow.
import {
  brandRef,
  categoryRef,
  DEAL_FIELDS,
  dealRef,
  PUBLISHED_OFFER_FILTER,
  storeRef,
} from '../../../utils/offer-visibility';

const BANK_FIELDS = ['name', 'slug', 'shortDescription', 'logoAlt'];
const menuStoreRef = {
  ...storeRef,
  fields: [...storeRef.fields, 'pageTemplate'],
};
const menuCategoryRef = {
  ...categoryRef,
  fields: [...categoryRef.fields, 'pageTemplate'],
};

// Relations in homepage components are curator-managed and therefore have no
// database-level cardinality bound. Constrain visibility in the query while
// preserving the editor's relation order, then cap the returned payload
// defensively below. Each section holds a +4 buffer over what the site renders,
// so a mid-cycle expiry/delete never leaves a visible hole (the UI slices to
// its own display counts).
export const MAX_LIST_ITEMS = 16;

export const MAX_TOP_STORES = 18;

export const TOP_DEALS_RENDER_COUNT = 6;

export const SECTION_LIST_CAPS = {
  popularStores: 31, // site shows 31
  topDeals: 10, // site shows 6
  offersByBrand: 10, // site shows 6
  exploreOffersPerTab: 10, // site shows 6 per tab
} as const;

export const COUPON_FIELDS = [
  'title',
  'content',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
  'badge',
  'code',
  'couponType',
  'affiliateLink',
  // Consumed and removed by the festive-offer walker.
  'checkoutMerchant',
  // Affiliate-brand offers render the BRAND logo in their identity slot.
  'isForAffiliateBrand',
  'expiresAt',
  'contentStatus',
];

const bankRef = { fields: BANK_FIELDS, populate: { logo: true } };

const couponRef = {
  fields: COUPON_FIELDS,
  populate: {
    logoStore: storeRef,
    stores: storeRef,
    brands: brandRef,
    // The pool documentId (always emitted alongside the selected fields) is
    // what lets the frontend render the unique-code "Unlock Coupon" flow; the
    // allocated codes themselves stay behind /unique-coupon/redeem.
    uniqueCouponPool: { fields: ['name'] },
  },
};

// Hero products use the full Deal projection: their CTA opens the shared
// redeem modal, whose "Deal Details" section is composed from
// computedContent + written `content` like every other Deal surface.
const heroDealRef = { ...dealRef };

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

// Strapi's Document Service accepts nested ordering here, but adding `sort`
// would override the relation order editors set by drag-and-drop. It rejects
// nested `limit`/pagination keys, so the response-level cap below remains the
// compatibility-safe cardinality guard.
const publishedCouponListRef = {
  ...publishedCouponRef,
};

export const publishedDealListRef = {
  ...publishedDealRef,
};

const bannerSlides = {
  populate: { desktopImage: true },
};

export const HOMEPAGE_POPULATE = {
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

export const MENU_POPULATE = {
  topStores: menuStoreRef,
  searchTopStores: { populate: { store: menuStoreRef } },
  searchSuggestions: true,
  categorySections: {
    populate: {
      icon: true,
      category: menuCategoryRef,
      links: { populate: { icon: true, store: menuStoreRef, category: menuCategoryRef } },
    },
  },
  extraItems: { populate: { store: menuStoreRef, category: menuCategoryRef } },
} as const;

export const FOOTER_POPULATE = {
  sections: {
    populate: { links: { populate: { store: menuStoreRef, category: menuCategoryRef } } },
  },
  socialLinks: true,
  countries: { populate: { flag: true } },
  partnerCard: true,
  googlePreferredCard: { populate: { icon: true } },
} as const;

export const GLOBAL_POPULATE = {
  telegramCta: true,
  newsletter: true,
} as const;

export const HEADER_NOTIFICATION_POPULATE = {
  notification: {
    populate: {
      coupon: {
        populate: {
          imageOverride: true,
          coupon: {
            fields: ['title', 'contentStatus', 'expiresAt'],
            populate: {
              logoStore: storeRef,
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
            populate: { dealImage: true, logoStore: storeRef },
          },
        },
      },
    },
  },
} as const;

export const MANAGED_SINGLE_ROUTES = [
  ['api::homepage.homepage', '/'],
  ['api::about-page.about-page', '/about-us/'],
  ['api::career-page.career-page', '/careers/'],
  ['api::contact-page.contact-page', '/contact-us/'],
  ['api::faq-page.faq-page', '/faqs/'],
  ['api::testimonials-page.testimonials-page', '/testimonials/'],
  ['api::partner-with-us-page.partner-with-us-page', '/partner-with-us/'],
  ['api::culture-page.culture-page', '/culture/'],
  ['api::privacy-policy-page.privacy-policy-page', '/privacy-policy/'],
  [
    'api::terms-and-conditions-page.terms-and-conditions-page',
    '/terms-and-conditions/',
  ],
  [
    'api::affiliate-disclosure-page.affiliate-disclosure-page',
    '/affiliate-disclosure/',
  ],
] as const;
