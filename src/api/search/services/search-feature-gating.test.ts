import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INDIA_DEFAULT_CONFIGURATION } from '../../site-configuration/services/country-registry';

const mocks = vi.hoisted(() => ({
  cachedSiteConfiguration: vi.fn(),
  preview: vi.fn(async () => ({ mode: 'preview' })),
  group: vi.fn(async () => ({ mode: 'group' })),
}));

vi.mock('../../site-configuration/services/cached-configuration', () => ({
  cachedSiteConfiguration: mocks.cachedSiteConfiguration,
}));

vi.mock('./search-results', () => ({
  preview: mocks.preview,
  group: mocks.group,
}));

import createSearchService from './search';

const strapi = { log: { info: vi.fn() } } as any;

function liveKeysArg(fn: typeof mocks.preview): string[] {
  const call = fn.mock.calls.at(-1);
  return [...(call?.[3] as ReadonlySet<string>)].sort();
}

describe('search feature gating', () => {
  beforeEach(() => {
    mocks.cachedSiteConfiguration.mockReset();
    mocks.preview.mockClear();
    mocks.group.mockClear();
  });

  it('passes every kind when all features are enabled', async () => {
    mocks.cachedSiteConfiguration.mockResolvedValue(INDIA_DEFAULT_CONFIGURATION);
    const service = createSearchService({ strapi });

    await service.search({ mode: 'preview', query: 'shoes' } as any);
    expect(liveKeysArg(mocks.preview)).toEqual([
      'banks',
      'brands',
      'categories',
      'coupons',
      'deals',
      'stores',
    ]);
  });

  it('drops disabled kinds from the live set', async () => {
    mocks.cachedSiteConfiguration.mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      categoriesEnabled: false,
      productDealsEnabled: false,
    });
    const service = createSearchService({ strapi });

    await service.search({ mode: 'group', query: 'shoes', group: 'stores', page: 1, pageSize: 10 } as any);
    expect(liveKeysArg(mocks.group as any)).toEqual([
      'banks',
      'brands',
      'coupons',
      'stores',
    ]);
  });
});
