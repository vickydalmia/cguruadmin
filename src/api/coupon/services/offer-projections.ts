// Offer PROJECTIONS: the public field lists, populate shapes, default
// sort and page-size clamps shared by every coupon/deal read. One of the
// modules split out of the coupon controller (see
// ../controllers/custom.ts).
import { publishedOnlyFilters } from '../../../utils/content-status';
import { AMAZON_AFFILIATE_DISCLOSURE_FIELD } from '../../../utils/amazon-affiliate-disclosure';

export const MAX_PAGE_SIZE = 100;

export const clampPageSize = (raw: unknown, fallback: number) =>
  Math.max(1, Math.min(Number(raw) || fallback, MAX_PAGE_SIZE));

export const visibilityFilters = () => publishedOnlyFilters();

// Default page size for the global /offers and /deals listings (max 100 via
// clampPageSize). Matches the "24 per page" grid the frontend renders.
export const DEFAULT_LIST_PAGE_SIZE = 24;

// Ordering for global listings and for the non-editorial portion of entity
// listings: newest first. Entity Coupon listings may prepend orderedCoupons.
export const DEFAULT_OFFER_SORT = [
  // Editor-controlled sort key — see NEWEST_FIRST in src/utils/offer-visibility.ts.
  { publishedOn: 'desc' },
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

// Public-safe scalar whitelists. Richtext `content` is included since the
// `excerpt` field was removed. Homepage full-card sections also consume this
// field; compact Hero and Top Offers references intentionally omit it.
export const COUPON_PUBLIC_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
  'badge',
  'content',
  'code',
  'couponType',
  'affiliateLink',
  // Read by the festive-offer walker, which strips it from the response before
  // it reaches the UI (see src/utils/festive-offer-response.ts).
  'checkoutMerchant',
  // Drives the per-offer store-style card on entity pages (no listing logo).
  'isForAffiliateBrand',
  // Csv of offer-country registry codes ("AE,SA") — flag tags + the entity
  // Country filter. Null/absent = valid everywhere.
  'offerCountries',
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'publishedOn',
];

export const DEAL_PUBLIC_FIELDS = [
  'title',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
  'badge',
  'content',
  'code',
  'couponType',
  'salePrice',
  'mrp',
  'discount',
  'discountPrefix',
  'affiliateLink',
  // Read by the festive-offer walker, which strips it from the response before
  // it reaches the UI (see src/utils/festive-offer-response.ts).
  'checkoutMerchant',
  // Drives the per-offer store-style card on entity pages (no listing logo).
  'isForAffiliateBrand',
  // Csv of offer-country registry codes ("AE,SA") — flag tags + the entity
  // Country filter. Null/absent = valid everywhere.
  'offerCountries',
  // Consumed and removed by arrayizeOfferText after it derives the final
  // Amazon Creator Connections condition.
  AMAZON_AFFILIATE_DISCLOSURE_FIELD,
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'publishedOn',
];

// Related-entity refs expose only name/slug plus the entity's media and its
// alt text (`logoAlt`, or `iconAlt` for categories — every media field has an
// editor-supplied alt now). Nothing else about a store/bank/brand/category
// leaks into a listing.
export const storeRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };

export const bankRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };

export const brandRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };

export const categoryRef = { fields: ['name', 'slug', 'iconAlt'], populate: { icon: true } };

// Coupon populate for public listings. `uniqueCouponPool` is populated with the
// pool NAME only — its `codes` relation is never referenced, so redeemable
// unique codes can never be harvested through this endpoint.
export const COUPON_PUBLIC_POPULATE = {
  logoStore: storeRef,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
  uniqueCouponPool: { fields: ['name'] },
};

export const DEAL_PUBLIC_POPULATE = {
  dealImage: true,
  logoStore: storeRef,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
  uniqueCouponPool: { fields: ['name'] },
};
