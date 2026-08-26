import { describe, expect, it } from 'vitest';

import { filterHomepage } from './homepage-filter';
import type { FeatureReadinessMap } from './feature-readiness';

function features(overrides: Record<string, boolean>): FeatureReadinessMap {
  return new Proxy({} as FeatureReadinessMap, {
    get: (_target, key: string) => ({ live: overrides[key] ?? true }),
  });
}

describe('filterHomepage', () => {
  it('disables Product Deal rails when their campaign landing is not live', () => {
    const homepage = {
      hero: { products: [{ documentId: 'deal-1' }] },
      topDeals: { enabled: true },
    };

    filterHomepage(homepage, features({ dealOfTheDay: false }));

    // Hero cards link to their own Deal detail pages, not the campaign landing.
    expect(homepage.hero.products).toHaveLength(1);
    expect(homepage.topDeals.enabled).toBe(false);
  });

  it('retains Product Deal rails when catalog and campaign are live', () => {
    const homepage = {
      hero: { products: [{ documentId: 'deal-1' }] },
      topDeals: { enabled: true },
    };

    filterHomepage(homepage, features({}));

    expect(homepage.hero.products).toHaveLength(1);
    expect(homepage.topDeals.enabled).toBe(true);
  });
});
