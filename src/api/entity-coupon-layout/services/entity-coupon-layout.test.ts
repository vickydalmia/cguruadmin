import { describe, expect, it, vi } from 'vitest';
import {
  CouponLayoutError,
  createEntityCouponLayoutService,
  ENTITY_COUPON_LAYOUT_ACTION,
  ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
  PREVIEW_COUPON_LIMIT,
  couponLayoutInvalidation,
  parseLayoutSelection,
} from './entity-coupon-layout';

describe('entity Coupon layout selection contract', () => {
  it('registers as a core Administration Panel settings action', () => {
    expect(ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES).toMatchObject({
      section: 'settings',
      pluginName: 'admin',
      uid: 'entity-coupon-layout.manage',
    });
    expect(ENTITY_COUPON_LAYOUT_ACTION).toBe(
      `admin::${ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES.uid}`,
    );
  });

  it('allows buffer overlap but rejects displayed Top Pick overlap', () => {
    expect(
      parseLayoutSelection({
        topPickCouponIds: ['a', 'b', 'c'],
        orderedCouponIds: ['c', 'd'],
      }),
    ).toEqual({
      topPickCouponIds: ['a', 'b', 'c'],
      orderedCouponIds: ['c', 'd'],
    });
    expect(() =>
      parseLayoutSelection({
        topPickCouponIds: ['a', 'b', 'c'],
        orderedCouponIds: ['b'],
      }),
    ).toThrowError(CouponLayoutError);
  });

  it('rejects duplicates and limits before any write', () => {
    expect(() =>
      parseLayoutSelection({
        topPickCouponIds: ['a', 'a'],
        orderedCouponIds: [],
      }),
    ).toThrow(/same Coupon/);
    expect(() =>
      parseLayoutSelection({
        topPickCouponIds: [],
        orderedCouponIds: Array.from({ length: 11 }, (_, index) => `c${index}`),
      }),
    ).toThrow(/at most 10/);
  });
});

function coupon(documentId: string, id: number) {
  return {
    id,
    documentId,
    title: `Coupon ${documentId}`,
    couponType: 'code',
    badge: null,
    expiresAt: null,
    publishedOn: '2026-07-01T00:00:00.000Z',
  };
}

function serviceHarness(options?: {
  findMany?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
}) {
  const findMany = options?.findMany ?? vi.fn(async () => []);
  const count = options?.count ?? vi.fn(async () => 0);
  const couponDocuments = { findMany, count };
  const strapi = {
    db: {
      query: vi.fn(() => ({
        findOne: vi.fn(async () => ({
          id: 1,
          documentId: 'store-1',
          slug: 'store-one',
          updatedAt: '2026-07-29T00:00:00.000Z',
          topPickCoupons: [],
          orderedCoupons: [],
        })),
      })),
    },
    documents: vi.fn(() => couponDocuments),
  } as any;
  return {
    service: createEntityCouponLayoutService({ strapi }),
    findMany,
    count,
  };
}

describe('entity Coupon layout queries', () => {
  it('applies deterministic title sorting to candidate requests', async () => {
    const { service, findMany } = serviceHarness();

    await service.candidates('store', 'store-1', {
      sort: 'title',
      page: 2,
      pageSize: 25,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [{ title: 'asc' }, { id: 'asc' }],
        start: 25,
        limit: 25,
      }),
    );
  });

  it('returns the exact eligible count without loading every preview row', async () => {
    const automatic = Array.from({ length: 40 }, (_, index) =>
      coupon(`automatic-${index}`, index + 10),
    );
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([coupon('selected-top', 2)])
      .mockResolvedValueOnce(automatic);
    const count = vi.fn(async () => 237);
    const { service } = serviceHarness({ findMany, count });

    const preview = await service.preview('store', 'store-1', {
      topPickCouponIds: ['selected-top'],
      orderedCouponIds: [],
    });

    expect(preview.total).toBe(237);
    expect(preview.topPicks.map((item) => item.documentId)).toEqual([
      'selected-top',
      'automatic-0',
    ]);
    expect(preview.coupons).toHaveLength(PREVIEW_COUPON_LIMIT);
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      limit: 46,
    });
    expect(count).toHaveBeenCalledOnce();
  });
});

describe('coupon layout invalidation targets', () => {
  const storeConfig = { kind: 'store' as const, publicPath: 'stores' };

  // Regression: this used to trim slashes only, so a namespaced slug produced
  // `/store/amazon/` — a durable outbox event for a path that does not exist,
  // leaving the real page stale after every reorder.
  it('strips an owned type namespace from the page paths', () => {
    for (const slug of ['store/amazon', 'stores/amazon', '/amazon/']) {
      expect(couponLayoutInvalidation(storeConfig, slug).pagePaths).toEqual([
        '/amazon/',
        '/sitemap_index.xml',
      ]);
    }
  });

  it('does not invalidate Product Deal surfaces', () => {
    const { pagePaths, cachePaths } = couponLayoutInvalidation(
      storeConfig,
      'amazon',
    );
    expect(pagePaths).toEqual(['/amazon/', '/sitemap_index.xml']);
    expect(cachePaths).toEqual(['/api/stores/amazon/coupons']);
  });

  // The response cache is keyed by Koa's ctx.path, which keeps the request's
  // percent-encoding — and the frontend sends encodeURIComponent(sourceSlug)
  // as ONE segment. The prefix must match that byte-for-byte: a raw
  // `store/amazon` prefix matched nothing, so layout saves silently left the
  // stale cached ordering for the ISR re-render to consume.
  it('keys the response cache on the encoded request-path slug', () => {
    expect(couponLayoutInvalidation(storeConfig, 'store/amazon').cachePaths)
      .toEqual(['/api/stores/store%2Famazon/coupons']);
    expect(couponLayoutInvalidation(storeConfig, 'make my trip').cachePaths)
      .toEqual(['/api/stores/make%20my%20trip/coupons']);
    // Plain slugs are unchanged by encoding.
    expect(couponLayoutInvalidation(storeConfig, 'amazon').cachePaths)
      .toEqual(['/api/stores/amazon/coupons']);
  });

  it('emits no page paths for an unroutable slug', () => {
    expect(couponLayoutInvalidation(storeConfig, '').pagePaths).toEqual([]);
    expect(couponLayoutInvalidation(storeConfig, null).pagePaths).toEqual([]);
  });
});

describe('stale saved selections self-heal', () => {
  function harness(liveIds: string[], stored: any[]) {
    const findMany = vi.fn(async (options: any) => {
      const requested: string[] =
        options?.filters?.documentId?.$in ?? liveIds;
      return requested
        .filter((id) => liveIds.includes(id))
        .map((id, index) => coupon(id, index + 1));
    });
    const strapi = {
      db: {
        query: vi.fn(() => ({
          findOne: vi.fn(async () => ({
            id: 1,
            documentId: 'store-1',
            slug: 'store-one',
            updatedAt: '2026-07-29T00:00:00.000Z',
            topPickCoupons: stored,
            orderedCoupons: [],
          })),
        })),
      },
      documents: vi.fn(() => ({ findMany, count: vi.fn(async () => 0) })),
      db_: null,
    } as any;
    return createEntityCouponLayoutService({ strapi });
  }

  // Previously a single expired saved pick made the whole entity unsaveable:
  // the GET returned it, the dialog sent it back, and the save 400'd.
  it('drops an already-saved pick that is no longer live', async () => {
    const service = harness(
      ['live-a'],
      [
        { documentId: 'live-a', title: 'Live A' },
        { documentId: 'gone-b', title: 'Expired B' },
      ],
    );

    const preview = await service.preview('store', 'store-1', {
      topPickCouponIds: ['live-a', 'gone-b'],
      orderedCouponIds: [],
    });

    expect(preview.topPicks.map((item: any) => item.documentId)).not.toContain(
      'gone-b',
    );
  });

  // A newly added ineligible id is a race or a client bug, not lifecycle —
  // the candidate list only ever offers live Coupons.
  it('still rejects an ineligible id that was not already saved', async () => {
    const service = harness(['live-a'], [{ documentId: 'live-a', title: 'Live A' }]);

    await expect(
      service.preview('store', 'store-1', {
        topPickCouponIds: ['live-a', 'never-saved'],
        orderedCouponIds: [],
      }),
    ).rejects.toThrow(/live Coupons/);
  });
});

describe('preview mirrors the storefront Top Pick rules', () => {
  // build-unified-entity-page-view filters orderedCouponIds out of the
  // automatic candidates before calling selectEntityTopPicks. Promoting an
  // ordered Coupon here would both show it in a section the page will not put
  // it in AND remove it from the main-list row where the page actually
  // renders it.
  it('never fills a Top Pick slot from the ordered head', async () => {
    const ordered = coupon('ordered-1', 5);
    const fresh = coupon('automatic-1', 6);
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([coupon('curated-top', 2), ordered])
      .mockResolvedValueOnce([ordered, fresh]);
    const { service } = serviceHarness({ findMany, count: vi.fn(async () => 3) });

    const preview = await service.preview('store', 'store-1', {
      topPickCouponIds: ['curated-top'],
      orderedCouponIds: ['ordered-1'],
    });

    expect(preview.topPicks.map((item) => item.documentId)).toEqual([
      'curated-top',
      'automatic-1',
    ]);
    // The ordered Coupon keeps its main-list position.
    expect(preview.coupons.map((item) => item.documentId)).toContain(
      'ordered-1',
    );
  });

  // selectEntityTopPicks: `if (selected.length < 2) return []`. An entity with
  // one eligible Coupon renders no Top Picks section and keeps that Coupon in
  // the main list.
  it('shows no Top Picks when fewer than two are available', async () => {
    const only = coupon('only-one', 3);
    // No selection means validateEligibleSelection short-circuits without
    // querying, so the only findMany call is the automatic pool.
    const findMany = vi.fn().mockResolvedValueOnce([only]);
    const { service } = serviceHarness({ findMany, count: vi.fn(async () => 1) });

    const preview = await service.preview('store', 'store-1', {
      topPickCouponIds: [],
      orderedCouponIds: [],
    });

    expect(preview.topPicks).toEqual([]);
    expect(preview.coupons.map((item) => item.documentId)).toEqual(['only-one']);
  });

  it('still displays exactly two once two are available', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([coupon('a', 1), coupon('b', 2), coupon('c', 3)]);
    const { service } = serviceHarness({ findMany, count: vi.fn(async () => 3) });

    const preview = await service.preview('store', 'store-1', {
      topPickCouponIds: [],
      orderedCouponIds: [],
    });

    expect(preview.topPicks.map((item) => item.documentId)).toEqual(['a', 'b']);
    expect(preview.coupons.map((item) => item.documentId)).toEqual(['c']);
  });
});
