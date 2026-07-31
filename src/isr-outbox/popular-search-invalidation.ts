const ENTITY_UIDS = new Set([
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
]);

// affectsPopularSearchInventory was removed with the middleware's leaderboard
// change detection — offer writes no longer trigger any popular-search work.
// The identity helpers below remain: an entity rename/reslug still broadens
// its ISR event to {full:true} because the old name/slug is baked into HTML
// site-wide (rails, navigation, interlinks).

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
