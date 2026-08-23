// Independence Day Sale POPULATE/QUERY DEFINITIONS: coupon field
// projection and the page populate tree. Split out of ./custom.ts, which
// keeps the load -> sanitize -> transform -> send flow.
import {
  brandRef,
  categoryRef,
  dealRef,
  PUBLISHED_OFFER_FILTER,
  storeRef,
} from '../../../utils/offer-visibility';

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
  'checkoutMerchant',
  // Affiliate-brand offers render the BRAND logo in their identity slot.
  'isForAffiliateBrand',
  'expiresAt',
  'scheduledAt',
  'contentStatus',
  'publishedOn',
  'publishedAt',
  'updatedAt',
  'createdAt',
] as const;

const bankRef = {
  fields: ['name', 'slug', 'logoAlt'],
  populate: { logo: true },
};

export const couponRef = {
  fields: COUPON_FIELDS,
  populate: {
    logoStore: storeRef,
    stores: storeRef,
    brands: brandRef,
    categories: categoryRef,
    banks: bankRef,
    uniqueCouponPool: { fields: ['name'] },
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

export const PAGE_POPULATE = {
  countdown: true,
  hero: { populate: { image: true } },
  topPicks: {
    populate: { viewAllCta: true, offers: publishedCouponRef },
  },
  couponsByCategory: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          iconOverride: true,
          category: categoryRef,
          offers: publishedCouponRef,
        },
      },
    },
  },
  productDealsByCategory: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          category: categoryRef,
          deals: publishedDealRef,
        },
      },
    },
  },
  promoStrip: { populate: { cta: true } },
  couponsByStore: {
    populate: {
      tabs: {
        populate: {
          store: storeRef,
          offers: publishedCouponRef,
        },
      },
    },
  },
  allCoupons: {
    // Keep the unfiltered relation long enough to distinguish an editor-curated
    // list from an intentionally empty relation. Public output is filtered by
    // fillAllCouponHolder before the response is sent.
    populate: { viewAllCta: true, offers: couponRef },
  },
  allDeals: {
    populate: { viewAllCta: true, deals: dealRef },
  },
  popularSearches: {
    populate: {
      stores: { fields: ['name', 'slug'] },
      brands: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
      banks: { fields: ['name', 'slug'] },
    },
  },
  seo: { populate: { ogImage: true } },
} as const;
