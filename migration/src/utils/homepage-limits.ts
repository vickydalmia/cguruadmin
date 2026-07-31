/**
 * Per-section homepage seed counts. Each section holds a +4 buffer over what
 * the site renders (cguru-ui HOME_SECTION_LIMITS), so a mid-cycle expiry or
 * delete never leaves a visible hole.
 *
 * Repeatable-component sections must not exceed the component schema `max`
 * (`src/components/home/*.json`) — direct-SQL migration writes bypass
 * Strapi's validation, so the parity test in
 * `migration/test/homepage-limits.test.ts` enforces the match instead.
 */
export const HOMEPAGE_SEED_LIMITS = {
  heroProducts: 4, // site shows 4 — no buffer by design
  popularStores: 31, // list stores, +1 featured on top — no buffer by design
  topOffers: 8, // site shows 4
  topDeals: 10, // site shows 6
  cgExclusive: 8, // site shows 4
  exploreOffersPerTab: 10, // site shows 6 per tab
  newlyAdded: 8, // site shows 4
  offersByBrand: 7, // site shows 3
  bankOffers: 12, // site shows 8
} as const;
