/**
 * Affiliate-brand offers — a Coupon/Deal flagged `isForAffiliateBrand` belongs
 * exclusively to affiliate Brands (`brand.isAffiliateStore`): no Stores, no
 * Logo Store, no Checkout merchant, and only affiliate Brands in the picker.
 *
 * The toggle is rendered by the Taxonomies side panel (not the main edit
 * form), and `logoStore`/`checkoutMerchant` hide via schema
 * `conditions.visible` when it is ON. Hidden fields are OMITTED from the
 * admin's PUT body, so the durable clearing lives server-side in
 * utils/affiliate-offer-consistency.ts, alongside the write validator that
 * enforces the invariant for Content-Manager writes.
 *
 * NULL semantics: `default: false` sets no DB column default, so legacy rows
 * hold NULL. Every consumer must treat only `=== true` as ON — the schema
 * conditions use `!= true`, the picker filter uses `$eq: true`.
 *
 * Imported by BOTH halves of the app (server pipeline and admin bundle),
 * which is why it lives in src/constants rather than src/utils.
 */

/** Toggle attribute on both offer schemas. */
export const AFFILIATE_OFFER_TOGGLE_FIELD = 'isForAffiliateBrand';

/** Flag attribute on the Brand schema (label: "Affiliate Store"). */
export const BRAND_AFFILIATE_FLAG_FIELD = 'isAffiliateStore';

/** Content types that carry the toggle. Both offer types. */
export const AFFILIATE_OFFER_UIDS = [
  'api::coupon.coupon',
  'api::deal.deal',
] as const;

export type AffiliateOfferUid = (typeof AFFILIATE_OFFER_UIDS)[number];

export function isAffiliateOfferUid(uid: unknown): uid is AffiliateOfferUid {
  return AFFILIATE_OFFER_UIDS.includes(uid as AffiliateOfferUid);
}
