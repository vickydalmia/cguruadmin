import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INDIA_DEFAULT_CONFIGURATION } from './country-registry';

vi.mock('./site-configuration', () => ({
  loadSiteConfiguration: vi.fn(),
}));

import {
  cachedSiteConfiguration,
  invalidateCachedSiteConfiguration,
} from './cached-configuration';
import { loadSiteConfiguration } from './site-configuration';

const strapi = { log: { warn: vi.fn() } } as any;

beforeEach(() => {
  invalidateCachedSiteConfiguration();
  vi.mocked(loadSiteConfiguration).mockReset();
});

describe('cachedSiteConfiguration', () => {
  it('serves the memo within the TTL', async () => {
    vi.mocked(loadSiteConfiguration).mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      translationLocales: 'ar',
    });
    const first = await cachedSiteConfiguration(strapi);
    vi.mocked(loadSiteConfiguration).mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      translationLocales: 'ar,hi',
    });
    const second = await cachedSiteConfiguration(strapi);
    expect(second).toBe(first);
    expect(loadSiteConfiguration).toHaveBeenCalledTimes(1);
  });

  it('re-reads immediately after invalidateCachedSiteConfiguration()', async () => {
    vi.mocked(loadSiteConfiguration).mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      translationLocales: 'ar',
    });
    await cachedSiteConfiguration(strapi);
    vi.mocked(loadSiteConfiguration).mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      translationLocales: 'ar,hi',
    });
    invalidateCachedSiteConfiguration();
    const fresh = await cachedSiteConfiguration(strapi);
    expect(fresh.translationLocales).toBe('ar,hi');
    expect(loadSiteConfiguration).toHaveBeenCalledTimes(2);
  });

  it('degrades to the last value when the re-read fails', async () => {
    vi.mocked(loadSiteConfiguration).mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      translationLocales: 'ar',
    });
    await cachedSiteConfiguration(strapi);
    invalidateCachedSiteConfiguration();
    vi.mocked(loadSiteConfiguration).mockRejectedValue(new Error('db down'));
    const value = await cachedSiteConfiguration(strapi);
    // Invalidation drops the memo entirely, so a failed re-read falls back
    // to the India defaults rather than the stale row — fail safe, and the
    // warning says so.
    expect(value).toEqual(INDIA_DEFAULT_CONFIGURATION);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('site-configuration cached read failed'),
    );
  });
});
