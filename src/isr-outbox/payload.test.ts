import { describe, expect, it } from 'vitest';
import {
  boundOutboxPayload,
  createOutboxPayload,
  hasOutboxWork,
  mergeScope,
} from './payload';

describe('createOutboxPayload', () => {
  it('normalizes and deduplicates page paths', () => {
    expect(
      createOutboxPayload({
        homepage: true,
        sitemap: true,
        slugs: ['amazon', '/amazon/', ' categories/deals '],
      }),
    ).toEqual({
      paths: ['/', '/sitemap_index.xml', '/amazon/', '/categories/deals/'],
      scopes: ['routes'],
    });
  });

  it('names the sitemap index, never the retired /sitemap.xml', () => {
    // /sitemap.xml was replaced by the index + shards. Emitting the old path
    // made every sitemap invalidation a silent no-op against a 404.
    const payload = createOutboxPayload({ sitemap: true });

    expect(payload.paths).toEqual(['/sitemap_index.xml']);
    expect(payload.paths).not.toContain('/sitemap.xml');
  });

  it('invalidates sitemap metadata when an offer changes', () => {
    // Adding an old offer to an entity changes that entity page now, even when
    // the offer's publishedOn date is months old. The sitemap index path lets
    // the gateway expand the invalidation to every live shard.
    const payload = createOutboxPayload({
      slugs: ['amazon-coupons'],
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    });

    expect(payload.paths).toEqual([
      '/',
      '/sitemap_index.xml',
      '/amazon-coupons/',
    ]);
    expect(payload.scopes).toEqual(['routes']);
  });

  it('marks global invalidation with route and redirect refresh scopes', () => {
    expect(
      createOutboxPayload({
        full: true,
        slugs: ['ignored'],
        refreshScopes: ['routes', 'redirects'],
      }),
    ).toEqual({
        all: true,
        scopes: ['routes', 'redirects'],
      });
  });

  it('deduplicates offer invalidations', () => {
    expect(
      createOutboxPayload(
        { homepage: true },
        [
          { entityType: 'coupon', documentId: 'coupon-1' },
          { entityType: 'coupon', documentId: 'coupon-1' },
        ],
      ),
    ).toEqual({
      paths: ['/'],
      offerInvalidations: [
        { entityType: 'coupon', documentId: 'coupon-1' },
      ],
    });
  });

  it('recognizes offer-only events as work', () => {
    expect(
      hasOutboxWork(
        createOutboxPayload(
          {},
          [{ entityType: 'deal', documentId: 'deal-1' }],
        ),
      ),
    ).toBe(true);
    expect(hasOutboxWork(createOutboxPayload({}))).toBe(false);
  });
});

describe('boundOutboxPayload', () => {
  it('promotes oversized path lists to one full invalidation', () => {
    expect(
      boundOutboxPayload(
        {
          paths: ['/one/', '/two/'],
          scopes: ['routes'],
          offerInvalidations: [
            { entityType: 'coupon', documentId: 'coupon-1' },
          ],
        },
        1,
        10_000,
      ),
    ).toEqual({
      all: true,
      scopes: ['routes'],
      offerInvalidations: [
        { entityType: 'coupon', documentId: 'coupon-1' },
      ],
    });
  });

  it('rejects a payload that remains too large after fallback', () => {
    expect(() =>
      boundOutboxPayload(
        {
          paths: ['/one/'],
          offerInvalidations: [
            { entityType: 'deal', documentId: 'x'.repeat(2_000) },
          ],
        },
        0,
        1_024,
      ),
    ).toThrow(/exceeds 1024 bytes/);
  });
});

describe('mergeScope', () => {
  it('unions before and after relation pages', () => {
    expect(
      mergeScope(
        { homepage: true, slugs: ['old-store'] },
        { sitemap: true, slugs: ['new-store', 'old-store'] },
      ),
    ).toEqual({
      full: false,
      homepage: true,
      sitemap: true,
      slugs: ['old-store', 'new-store'],
    });
  });

  it('returns null only when neither scope exists', () => {
    expect(mergeScope(null, null)).toBeNull();
  });
});
