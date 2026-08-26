import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_RUNTIME_CONFIG_PATH,
  clearRuntimePublicSiteUrlCache,
  loadRuntimePublicSiteUrl,
  unwrapRuntimePublicSiteUrl,
} from './runtime-config';

describe('public-offer runtime configuration', () => {
  beforeEach(clearRuntimePublicSiteUrlCache);

  it('unwraps the authenticated admin response and rejects other shapes', () => {
    expect(
      unwrapRuntimePublicSiteUrl({
        data: { data: { publicSiteUrl: ' https://www.example.com ' } },
      }),
    ).toBe('https://www.example.com');
    expect(
      unwrapRuntimePublicSiteUrl({ data: { publicSiteUrl: 'https://wrong.example' } }),
    ).toBeNull();
    expect(
      unwrapRuntimePublicSiteUrl({ data: { data: { publicSiteUrl: null } } }),
    ).toBeNull();
  });

  it('shares one request across Coupon and Deal row actions', async () => {
    const get = vi.fn(async () => ({
      data: { data: { publicSiteUrl: 'https://www.couponzguruusa.com' } },
    }));

    const [couponUrl, dealUrl] = await Promise.all([
      loadRuntimePublicSiteUrl(get),
      loadRuntimePublicSiteUrl(get),
    ]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ADMIN_RUNTIME_CONFIG_PATH);
    expect(couponUrl).toBe('https://www.couponzguruusa.com');
    expect(dealUrl).toBe(couponUrl);
  });

  it('evicts a failed request so a later click can retry', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        data: { data: { publicSiteUrl: 'https://www.example.com' } },
      });

    await expect(loadRuntimePublicSiteUrl(get)).rejects.toThrow('temporary failure');
    await expect(loadRuntimePublicSiteUrl(get)).resolves.toBe('https://www.example.com');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
