const OFFER_UIDS = new Set([
  'api::coupon.coupon',
  'api::deal.deal',
]);

const ENTITY_UIDS = new Set([
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
]);

const POPULAR_SEARCH_OFFER_FIELDS = new Set([
  'stores',
  'brands',
  'categories',
  'banks',
  'contentStatus',
  'scheduledAt',
  'expiresAt',
]);

export function affectsPopularSearchInventory(
  uid: string,
  action: string,
  data: unknown,
): boolean {
  if (!OFFER_UIDS.has(uid)) return false;
  if (action !== 'update') return true;
  if (!data || typeof data !== 'object') return false;
  return Object.keys(data).some((field) =>
    POPULAR_SEARCH_OFFER_FIELDS.has(field),
  );
}

export function isPopularSearchEntityUid(uid: string): boolean {
  return ENTITY_UIDS.has(uid);
}

export function entityPublicIdentityChanged(
  before: { name?: unknown; slug?: unknown } | null,
  after: { name?: unknown; slug?: unknown } | null,
): boolean {
  if (!before || !after) return false;
  return before.name !== after.name || before.slug !== after.slug;
}
