// The offer content types and their panel-owned taxonomy relation fields.
// Imported by BOTH halves of the app (browser-safe, no server imports):
// the admin Taxonomies panel builds its sections from these
// (src/admin/features/taxonomy-panel/config.ts) and the server hides the
// same relations from the default edit form
// (HIDE_FROM_EDIT in src/bootstrap/content-manager-visibility.ts). One source
// of truth keeps the pair in lockstep — a field listed in only one place
// either vanishes from the admin entirely (hidden from the form, absent
// from the panel) or grows two live controls that fight each other.
export const OFFER_TAXONOMY_UIDS = [
  'api::coupon.coupon',
  'api::deal.deal',
] as const;

export const OFFER_TAXONOMY_FIELDS = [
  'stores',
  'brands',
  'categories',
  'banks',
] as const;

export type OfferTaxonomyField = (typeof OFFER_TAXONOMY_FIELDS)[number];
