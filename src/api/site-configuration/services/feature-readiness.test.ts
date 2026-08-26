import { describe, expect, it, vi } from 'vitest';

import { INDIA_DEFAULT_CONFIGURATION } from './country-registry';
import { getFeatureReadiness } from './feature-readiness';

function strapiHarness(rows: Record<string, any>, counts: Record<string, number>) {
  return {
    documents: vi.fn((uid: string) => ({
      findFirst: vi.fn(async () => rows[uid] ?? null),
      findMany: vi.fn(async () => rows[`${uid}:many`] ?? []),
      count: vi.fn(async () => counts[uid] ?? 0),
    })),
  } as any;
}

describe('feature readiness', () => {
  it('does not treat India fallback copy as USA CMS content', async () => {
    const usa = {
      ...INDIA_DEFAULT_CONFIGURATION,
      countryCode: 'US',
      privacyPolicyEnabled: true,
    };
    const readiness = await getFeatureReadiness(strapiHarness({}, {}), usa);
    expect(readiness.privacyPolicy).toMatchObject({
      enabled: true,
      ready: false,
      live: false,
    });
    expect(readiness.privacyPolicy.reason).toMatch(/singleton is missing/u);
  });

  it('requires catalog records in addition to the flag', async () => {
    const config = { ...INDIA_DEFAULT_CONFIGURATION, storesEnabled: true };
    const readiness = await getFeatureReadiness(
      strapiHarness({}, { 'api::store.store': 0 }),
      config,
    );
    expect(readiness.stores).toMatchObject({ enabled: true, ready: false, live: false });
  });

  it('requires the campaign singleton, owner route and eligible live Deals', async () => {
    const config = { ...INDIA_DEFAULT_CONFIGURATION, countryCode: 'US' };
    const rows = {
      'api::deal-of-the-day-page.deal-of-the-day-page': { heroTitle: 'Today only' },
      'api::category.category:many': [
        { documentId: 'category-1', slug: 'daily-specials' },
      ],
    };
    const readiness = await getFeatureReadiness(
      strapiHarness(rows, {
        'api::deal.deal': 0,
      }),
      config,
    );
    expect(readiness.dealOfTheDay.live).toBe(false);
    expect(readiness.dealOfTheDay.reason).toMatch(/No eligible live Product Deals/u);
  });

  it('requires a template owner without reserving a category pathname', async () => {
    const config = { ...INDIA_DEFAULT_CONFIGURATION, countryCode: 'US' };
    const rows = {
      'api::independence-day-sale-page.independence-day-sale-page': {
        hero: { image: true },
        countdown: { saleEndAt: '2026-08-15' },
      },
      'api::store.store:many': [
        { documentId: 'store-1', slug: 'freedom-sale' },
      ],
    };
    const readiness = await getFeatureReadiness(strapiHarness(rows, {}), config);
    expect(readiness.independenceDaySale).toMatchObject({
      enabled: true,
      ready: true,
      live: true,
    });
  });
});
