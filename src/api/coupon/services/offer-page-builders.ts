// Offer DETAIL-PAGE BUILDERS: the coupon/deal page field lists, related
// limits, primary-entity resolution and renderability rules. One of the
// modules split out of the coupon controller (see
// ../controllers/custom.ts).
import {
  COUPON_PUBLIC_FIELDS,
  DEAL_PUBLIC_FIELDS,
} from './offer-projections';

export const OFFER_ID_PATTERN = /^[1-9]\d{0,14}$/;

// Feedback counters ride only on the detail-page payloads; card/list payloads
// (PUBLIC_FIELDS, RELATED_*) stay unchanged.
export const COUPON_PAGE_FIELDS = [
  ...COUPON_PUBLIC_FIELDS.filter((field) => field !== 'affiliateLink'),
  'workedCount',
  'failedCount',
];

export const DEAL_PAGE_FIELDS = [
  ...DEAL_PUBLIC_FIELDS.filter((field) => field !== 'affiliateLink'),
  'workedCount',
  'failedCount',
];

export const RELATED_DEAL_PAGE_FIELDS = DEAL_PUBLIC_FIELDS.filter(
  (field) => field !== 'affiliateLink',
);

export const COUPON_PAGE_RELATED_LIMIT = 4;

export const COUPON_PAGE_RELATED_DEAL_LIMIT = 6;

export const COUPON_PAGE_RELATED_DEAL_QUERY_LIMIT = 40;

export const DEAL_PAGE_RELATED_LIMIT = 4;

export const DEAL_PAGE_RELATED_QUERY_LIMIT = 40;

export function isRenderableCouponPageDeal(deal: any): boolean {
  return (
    typeof deal?.dealImage?.url === 'string' &&
    deal.dealImage.url.trim().length > 0
  );
}

export const PRIMARY_ENTITY_RELATIONS = [
  ['stores', 'store'],
  ['brands', 'brand'],
  ['banks', 'bank'],
  ['categories', 'category'],
] as const;

export function couponPagePrimaryEntity(coupon: any) {
  for (const [field, kind] of PRIMARY_ENTITY_RELATIONS) {
    const relation = Array.isArray(coupon?.[field]) ? coupon[field][0] : null;
    if (relation?.documentId && relation?.slug) {
      return { kind, ...relation };
    }
  }
  return null;
}

// Deals once named an explicit `primaryStore`; with that field removed the
// owning entity is resolved from the taxonomy exactly like a coupon's.
export function dealPagePrimaryEntity(deal: any) {
  return couponPagePrimaryEntity(deal);
}
