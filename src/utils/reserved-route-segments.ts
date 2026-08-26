// First path segments already owned by a real page or internal namespace in
// cguru-ui/src/pages/. Shared by the two validators that must agree on the
// key set: identity-validation.ts (an entity slug equal to one of these
// produces a `/{slug}/` route the framework already claims, so the entity
// page is either shadowed or overwrites a static page in the build output)
// and redirect-validation.ts (a redirect `from` one of these shadows the
// route in exactly the same way — `/search` redirecting somewhere takes site
// search offline).
//
// The KEYS must stay identical; the values deliberately differ per consumer
// (identity messages cite the src/pages/ file, redirect messages use a
// shorter editor-facing label). reserved-route-drift.test.ts imports both
// maps and fails when the key sets diverge.
//
// Derived from the actual files/namespaces — do not add speculative entries:
//   api/, 404.astro, 500.astro, about-us.astro, banks.astro, brands.astro,
//   careers.astro + careers/[slug].astro, categories.astro, contact-us.astro,
//   coupon/[id].astro,
//   deal/[id].astro, error-pages/[code].astro + error-pages/template.astro,
//   faqs.astro, redeem-unavailable.astro, robots.txt.ts, search.astro,
//   sitemap_index.xml.ts + sitemap/[shard].xml.ts, stores.astro
// (index.astro is the root and [...slug].astro is the entity catch-all
// itself, so neither reserves a segment.)

export const RESERVED_ROUTE_SEGMENTS = new Map<string, string>([
  ['404', 'the 404 page (src/pages/404.astro)'],
  ['500', 'the 500 page (src/pages/500.astro)'],
  ['about-us', 'the About Us page (src/pages/about-us.astro)'],
  ['api', 'the internal API namespace (src/pages/api/)'],
  ['banks', 'the bank listing page (src/pages/banks.astro)'],
  ['brands', 'the brand listing page (src/pages/brands.astro)'],
  ['careers', 'the careers pages (src/pages/careers.astro, careers/[slug].astro)'],
  ['categories', 'the category listing page (src/pages/categories.astro)'],
  ['contact-us', 'the Contact page (src/pages/contact-us.astro)'],
  ['coupon', 'the coupon detail pages (src/pages/coupon/[id].astro)'],
  ['deal', 'the deal detail pages (src/pages/deal/[id].astro)'],
  ['error-pages', 'the error pages (src/pages/error-pages/)'],
  ['faqs', 'the FAQ page (src/pages/faqs.astro)'],
  ['redeem-unavailable', 'the redeem fallback page (src/pages/redeem-unavailable.astro)'],
  ['robots.txt', 'the robots.txt route (src/pages/robots.txt.ts)'],
  ['search', 'the search page (src/pages/search.astro)'],
  ['sitemap', 'the sitemap shard namespace (src/pages/sitemap/[shard].xml.ts)'],
  ['sitemap_index.xml', 'the sitemap index route (src/pages/sitemap_index.xml.ts)'],
  ['stores', 'the store listing page (src/pages/stores.astro)'],
]);

export const REDIRECT_RESERVED_ROUTE_LABELS = new Map<string, string>([
  ['404', 'the 404 page'],
  ['500', 'the 500 page'],
  ['about-us', 'the About Us page'],
  ['api', 'the internal API namespace'],
  ['banks', 'the bank listing page'],
  ['brands', 'the brand listing page'],
  ['careers', 'the careers pages'],
  ['categories', 'the category listing page'],
  ['contact-us', 'the Contact page'],
  ['coupon', 'the coupon detail pages'],
  ['deal', 'the deal detail pages'],
  ['error-pages', 'the error pages'],
  ['faqs', 'the FAQ page'],
  ['redeem-unavailable', 'the redeem fallback page'],
  ['robots.txt', 'the robots.txt route'],
  ['search', 'the search page'],
  ['sitemap', 'the sitemap shard namespace'],
  ['sitemap_index.xml', 'the sitemap index route'],
  ['stores', 'the store listing page'],
]);
