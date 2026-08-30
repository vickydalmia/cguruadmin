import type { FeatureReadinessMap } from './feature-readiness';
import { homepageHeroEntityType } from '../../../utils/homepage-hero-offer';

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
  // landing. Keeping the cards while that campaign is inactive/incomplete
  // would either emit a dead owner path or strand the section without its
  // required navigation, so both dependencies must be live.
  const productDealsLive = enabled(features, 'productDeals');
  const couponsLive = enabled(features, 'coupons');
  if (homepage.hero?.products) {
    homepage.hero.products = homepage.hero.products.filter((item: any) => {
      const entityType = homepageHeroEntityType(item);
      return entityType === 'deal'
        ? productDealsLive
        : entityType === 'coupon'
          ? couponsLive
          : false;
    });
  }
  if (!productDealsLive || !enabled(features, 'dealOfTheDay')) {
    disableSection(homepage, 'topDeals');
  }
  if (!couponsLive) {
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
  const storesLive = enabled(features, 'stores');
  const brandsLive = enabled(features, 'brands');
  if (!storesLive) {
    if (homepage.popularStores) {
      homepage.popularStores.featuredStore = null;
      homepage.popularStores.stores = [];
    }
    if (homepage.popularSearches) homepage.popularSearches.stores = [];
  }
  if (!brandsLive) {
    if (homepage.popularStores) homepage.popularStores.brands = [];
    disableSection(homepage, 'offersByBrand');
    if (homepage.popularSearches) homepage.popularSearches.brands = [];
  }
  if (!storesLive && !brandsLive) {
    disableSection(homepage, 'popularStores');
  }
  if (!enabled(features, 'categories')) {
    disableSection(homepage, 'exploreOffers');
    if (homepage.popularSearches) homepage.popularSearches.categories = [];
  }
  if (!enabled(features, 'banks')) {
    disableSection(homepage, 'bankOffers');
    if (homepage.popularSearches) homepage.popularSearches.banks = [];
  }
  return homepage;
}
