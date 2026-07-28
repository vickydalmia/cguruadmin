/**
 * Entity Coupon layout: `topPickCoupons` + `orderedCoupons` for Store, Brand,
 * Category, and Bank.
 *
 * The two relations are edited on one screen because they interact: a
 * DISPLAYED Top Pick (the first two) is removed from the main list, so it
 * cannot also hold an Ordered Coupons position. Expiry buffers can — that
 * overlap is deliberate.
 *
 * The dedicated endpoint validates the complete final arrays atomically. The
 * dialog resolves conflicts as they are created; nightly reconciliation is a
 * safety net for legacy/direct-database corruption.
 *
 * Contract: cguruadmin/docs/entity-page-offer-ordering.md
 */

export type EntityScopeField = 'stores' | 'brands' | 'categories' | 'banks';

export type CouponLayoutConfig = {
  kind: 'store' | 'brand' | 'category' | 'bank';
  /** Entity API id used by the public preview endpoint, e.g. `stores`. */
  publicPath: EntityScopeField;
  /** Key the public endpoint nests the entity under, e.g. `store`. */
  publicEntityKey: 'store' | 'brand' | 'category' | 'bank';
  /** Filter used to scope Coupon candidates to this entity. */
  scopeRelationField: EntityScopeField;
  label: string;
};

export const TOP_PICK_FIELD = 'topPickCoupons';
export const ORDERED_FIELD = 'orderedCoupons';

/**
 * Mirrors the server limits. Duplicated rather than imported because the
 * validators pull in server-only modules that must not reach the admin bundle;
 * config.test.ts asserts the two stay equal.
 *
 * Top Picks accept 0–4. There is no minimum: a lone selection keeps slot one
 * and the storefront fills slot two with the newest eligible Coupon.
 */
export const TOP_PICK_MAX = 4;
export const ORDERED_MAX = 10;
/** Top Picks beyond this many are expiry buffers, not displayed positions. */
export const TOP_PICK_DISPLAYED = 2;

export const COUPON_LAYOUT_CONFIG: Record<string, CouponLayoutConfig> = {
  'api::store.store': {
    kind: 'store',
    publicPath: 'stores',
    publicEntityKey: 'store',
    scopeRelationField: 'stores',
    label: 'Store',
  },
  'api::brand.brand': {
    kind: 'brand',
    publicPath: 'brands',
    publicEntityKey: 'brand',
    scopeRelationField: 'brands',
    label: 'Brand',
  },
  'api::category.category': {
    kind: 'category',
    publicPath: 'categories',
    publicEntityKey: 'category',
    scopeRelationField: 'categories',
    label: 'Category',
  },
  'api::bank.bank': {
    kind: 'bank',
    publicPath: 'banks',
    publicEntityKey: 'bank',
    scopeRelationField: 'banks',
    label: 'Bank',
  },
};

export function couponLayoutConfig(model: string): CouponLayoutConfig | null {
  return COUPON_LAYOUT_CONFIG[model] ?? null;
}
