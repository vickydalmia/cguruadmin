import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateOfferRedeemCache,
  offerEntityTypeFromUid,
} from './invalidate';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ISR_GATEWAY_URL;
  delete process.env.ISR_REVALIDATE_SECRET;
});

describe('offer redeem cache invalidation', () => {
  it('maps only the dedicated Coupon and Deal content types', () => {
    expect(offerEntityTypeFromUid('api::coupon.coupon')).toBe('coupon');
    expect(offerEntityTypeFromUid('api::deal.deal')).toBe('deal');
    expect(offerEntityTypeFromUid('api::store.store')).toBeNull();
  });

  it('posts a delete-only exact invalidation and never sends warm data', async () => {
    process.env.ISR_GATEWAY_URL = 'http://gateway.internal:3010/';
    process.env.ISR_REVALIDATE_SECRET = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const strapi = { log: { info: vi.fn() } } as any;

    await invalidateOfferRedeemCache(
      strapi,
      'api::coupon.coupon',
      'coupon-document-1',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.internal:3010/revalidate');
    expect(JSON.parse(init.body)).toEqual({
      offerInvalidations: [
        { entityType: 'coupon', documentId: 'coupon-document-1' },
      ],
    });
    expect(init.body).not.toContain('affiliateLink');
  });
});
