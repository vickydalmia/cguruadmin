import { describe, expect, it } from 'vitest';
import {
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
      paths: ['/', '/sitemap.xml', '/amazon/', '/categories/deals/'],
      scopes: ['routes'],
    });
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
