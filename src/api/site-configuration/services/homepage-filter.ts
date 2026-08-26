import type { FeatureReadinessMap } from './feature-readiness';

function enabled(features: FeatureReadinessMap, key: keyof FeatureReadinessMap) {
  return features[key]?.live === true;
}

function disableSection(homepage: any, field: string): void {
  if (!homepage?.[field]) return;
  homepage[field] = { ...homepage[field], enabled: false };
}

export function filterHomepage(
  homepage: any,
  features: FeatureReadinessMap,
): any {
  if (!homepage) return homepage;

  // Product Deal rails use the live dealTemplate owner as their "View all"
  // landing. Keeping the cards while that campaign is disabled/incomplete
  // would either emit a dead legacy path or strand the section without its
  // required navigation, so both dependencies must be live.
  const productDealsLive = enabled(features, 'productDeals');
  if (!productDealsLive && homepage.hero) homepage.hero.products = [];
  if (!productDealsLive || !enabled(features, 'dealOfTheDay')) {
    for (const field of ['topDeals', 'dealsByBrand', 'exploreDeals']) {
      disableSection(homepage, field);
    }
  }
  if (!enabled(features, 'coupons')) {
    for (const field of [
      'topOffers',
      'cgExclusive',
      'newlyAdded',
      'offersByBrand',
      'exploreOffers',
    ]) {
      disableSection(homepage, field);
    }
  }
  if (!enabled(features, 'stores')) {
    disableSection(homepage, 'popularStores');
    if (homepage.popularSearches) homepage.popularSearches.stores = [];
  }
  if (!enabled(features, 'brands')) {
    disableSection(homepage, 'offersByBrand');
    disableSection(homepage, 'dealsByBrand');
    if (homepage.popularSearches) homepage.popularSearches.brands = [];
  }
  if (!enabled(features, 'categories')) {
    disableSection(homepage, 'exploreOffers');
    disableSection(homepage, 'exploreDeals');
    if (homepage.popularSearches) homepage.popularSearches.categories = [];
  }
  if (!enabled(features, 'banks')) {
    disableSection(homepage, 'bankOffers');
    if (homepage.popularSearches) homepage.popularSearches.banks = [];
  }
  return homepage;
}
