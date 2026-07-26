import { afterEach, describe, expect, it, vi } from 'vitest';

import createCouponController from './custom';

const REDEEM_TEST_SECRET = 'redeem-test-secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

function createHarness() {
  vi.stubEnv('ISR_ADMIN_SECRET', REDEEM_TEST_SECRET);

  const couponFindMany = vi.fn().mockResolvedValue([]);
  const couponFindOne = vi.fn().mockResolvedValue(null);
  const couponCount = vi.fn().mockResolvedValue(0);
  const dealFindMany = vi.fn().mockResolvedValue([]);
  const dealFindOne = vi.fn().mockResolvedValue(null);
  const dealCount = vi.fn().mockResolvedValue(0);
  const entityFindMany = vi.fn().mockResolvedValue([
    {
      documentId: 'store-amazon',
      name: 'Amazon',
      slug: 'amazon-coupons',
    },
  ]);
  const documents = vi.fn((uid: string) => {
    if (uid === 'api::coupon.coupon') {
      return { findMany: couponFindMany, findOne: couponFindOne, count: couponCount };
    }
    if (uid === 'api::deal.deal') {
      return { findMany: dealFindMany, findOne: dealFindOne, count: dealCount };
    }
    return { findMany: entityFindMany, count: vi.fn().mockResolvedValue(0) };
  });
  const sanitizeQuery = vi.fn(async (query: any) => query);
  const strapi = {
    documents,
    log: { warn: vi.fn() },
    service: vi.fn(() => ({
      relatedStores: vi.fn().mockResolvedValue({ stores: [] }),
    })),
    contentType: vi.fn(() => ({})),
    contentAPI: {
      validate: { query: vi.fn(async () => undefined) },
      sanitize: {
        query: sanitizeQuery,
        output: vi.fn(async (data: any) => data),
      },
    },
  } as any;
  const ctx = {
    params: { slug: 'amazon-coupons' },
    query: { page: '1', pageSize: '20' },
    state: { auth: null, entityType: 'store' },
    notFound: vi.fn(),
    unauthorized: vi.fn(),
    get: vi.fn((header: string) =>
      header.toLowerCase() === 'authorization'
        ? `Bearer ${REDEEM_TEST_SECRET}`
        : '',
    ),
    send: vi.fn((payload: any) => payload),
  };

  return {
    controller: createCouponController({ strapi }),
    ctx,
    couponFindMany,
    couponFindOne,
    couponCount,
    dealFindMany,
    dealFindOne,
    dealCount,
    entityFindMany,
    sanitizeQuery,
  };
}

describe('ISR offer route inventory', () => {
  it('returns every currently visible Coupon and Deal singular route', async () => {
    const harness = createHarness();
    harness.couponFindMany.mockResolvedValue([
      { id: 123, updatedAt: '2026-07-24T10:00:00.000Z' },
      { id: 0, updatedAt: 'invalid-id-is-skipped' },
    ]);
    harness.dealFindMany.mockResolvedValue([
      { id: 456, updatedAt: '2026-07-24T11:00:00.000Z' },
    ]);

    await harness.controller.getIsrOfferRoutes(harness.ctx);

    expect(harness.ctx.send).toHaveBeenCalledWith({
      data: [
        {
          path: '/coupon/123/',
          updatedAt: '2026-07-24T10:00:00.000Z',
        },
        {
          path: '/deal/456/',
          updatedAt: '2026-07-24T11:00:00.000Z',
        },
      ],
    });
    expect(harness.couponFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'published',
        fields: ['updatedAt'],
        start: 0,
        limit: 1_000,
      }),
    );
    expect(harness.dealFindMany).toHaveBeenCalledTimes(1);
  });

  it('paginates large inventories in bounded 1000-route batches', async () => {
    const harness = createHarness();
    const firstBatch = Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      updatedAt: '2026-07-24T10:00:00.000Z',
    }));
    harness.couponFindMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([
        { id: 1_001, updatedAt: '2026-07-24T11:00:00.000Z' },
      ]);

    await harness.controller.getIsrOfferRoutes(harness.ctx);

    expect(harness.couponFindMany).toHaveBeenCalledTimes(2);
    expect(harness.couponFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 'published',
        start: 1_000,
        limit: 1_000,
      }),
    );
    expect(harness.ctx.send).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        {
          path: '/coupon/1001/',
          updatedAt: '2026-07-24T11:00:00.000Z',
        },
      ]),
    });
  });
});

describe('public Coupon detail aggregate', () => {
  it('resolves a numeric Coupon id without exposing affiliate destinations', async () => {
    const harness = createHarness();
    harness.ctx.params = { id: '123' } as any;
    harness.couponFindMany
      .mockResolvedValueOnce([
        {
          id: 123,
          documentId: 'coupon-document-1',
          title: 'Save 20%',
          affiliateLink: 'https://merchant.invalid/private',
          stores: [
            {
              documentId: 'store-amazon',
              name: 'Amazon',
              slug: 'amazon-coupons',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 456,
          documentId: 'coupon-document-2',
          title: 'Save 10%',
        },
      ]);
    harness.dealFindMany.mockResolvedValue([
      {
        documentId: 'deal-invalid-image',
        title: 'Not renderable',
        salePrice: 999,
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        documentId: `deal-document-${index + 1}`,
        title: `Related deal ${index + 1}`,
        salePrice: index + 1 === 1 ? '1,299' : 999 + index,
        dealImage: { url: `/uploads/deal-${index + 1}.webp` },
      })),
    ]);

    const payload = await harness.controller.getCouponPage(harness.ctx as any);

    const detailQuery = harness.couponFindMany.mock.calls[0][0];
    expect(detailQuery.filters.id).toBe(123);
    expect(detailQuery.fields).not.toContain('affiliateLink');
    expect(payload.primaryEntity).toMatchObject({
      kind: 'store',
      slug: 'amazon-coupons',
    });
    expect(payload.relatedCoupons).toHaveLength(1);
    expect(payload.relatedDeals).toHaveLength(6);
    expect(payload.relatedDeals[0].documentId).toBe('deal-document-1');
    expect(harness.dealFindMany.mock.calls[0][0].limit).toBe(40);
  });

  it.each(['coupon-document-1', '0', '-1', '01', '9007199254740992'])(
    'rejects invalid Coupon id %s on the public route',
    async (id) => {
      const harness = createHarness();
      harness.ctx.params = { id } as any;

      await harness.controller.getCouponPage(harness.ctx as any);

      expect(harness.ctx.notFound).toHaveBeenCalledWith('Coupon not found');
      expect(harness.couponFindMany).not.toHaveBeenCalled();
    },
  );
});

describe('public Deal detail aggregate', () => {
  it('resolves a numeric Deal id with related product deals and no affiliate destinations', async () => {
    const harness = createHarness();
    harness.ctx.params = { id: '321' } as any;
    harness.dealFindMany
      .mockResolvedValueOnce([
        {
          id: 321,
          documentId: 'deal-document-1',
          title: 'ThinkBook 16',
          affiliateLink: 'https://merchant.invalid/private',
          salePrice: 55191,
          dealImage: { url: '/uploads/thinkbook.webp' },
          stores: [
            {
              documentId: 'store-lenovo',
              name: 'Lenovo',
              slug: 'lenovo-coupons',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        { documentId: 'invalid', title: 'Missing product image', salePrice: 999 },
        ...Array.from({ length: 5 }, (_, index) => ({
          id: index + 400,
          documentId: `related-deal-${index + 1}`,
          title: `Related product ${index + 1}`,
          salePrice: 999 + index,
          dealImage: { url: `/uploads/related-${index + 1}.webp` },
        })),
      ]);

    const payload = await harness.controller.getDealPage(harness.ctx as any);

    const detailQuery = harness.dealFindMany.mock.calls[0][0];
    expect(detailQuery.filters.id).toBe(321);
    expect(detailQuery.fields).not.toContain('affiliateLink');
    expect(payload.primaryEntity).toMatchObject({
      kind: 'store',
      slug: 'lenovo-coupons',
    });
    expect(payload.relatedDeals).toHaveLength(4);
    expect(payload.relatedDeals[0].documentId).toBe('related-deal-1');
    expect(harness.dealFindMany.mock.calls[1][0].limit).toBe(40);
  });

  it.each(['deal-document-1', '0', '-1', '01', '9007199254740992'])(
    'rejects invalid Deal id %s on the public route',
    async (id) => {
      const harness = createHarness();
      harness.ctx.params = { id } as any;

      await harness.controller.getDealPage(harness.ctx as any);

      expect(harness.ctx.notFound).toHaveBeenCalledWith('Deal not found');
      expect(harness.dealFindMany).not.toHaveBeenCalled();
    },
  );
});

describe('private offer redeem resolver', () => {
  it('resolves a Coupon with only the required safe pool reference', async () => {
    const harness = createHarness();
    harness.ctx.params = {
      entityType: 'coupon',
      documentId: 'coupon-document-1',
    } as any;
    harness.couponFindOne.mockResolvedValue({
      documentId: 'coupon-document-1',
      title: 'Save 20%',
      couponType: 'unique',
      uniqueCouponPool: { documentId: 'pool-1' },
    });

    const payload = await harness.controller.getRedeemOffer(harness.ctx as any);

    expect(harness.couponFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'coupon-document-1',
        status: 'published',
        fields: expect.arrayContaining(['title', 'code', 'couponType', 'affiliateLink']),
        populate: expect.objectContaining({
          uniqueCouponPool: { fields: ['name'] },
        }),
      }),
    );
    expect(payload.data.documentId).toBe('coupon-document-1');
  });

  it('never guesses the entity type from the document id', async () => {
    const harness = createHarness();
    harness.ctx.params = {
      entityType: 'offer',
      documentId: 'coupon-document-1',
    } as any;

    await harness.controller.getRedeemOffer(harness.ctx as any);

    expect(harness.ctx.notFound).toHaveBeenCalled();
    expect(harness.couponFindOne).not.toHaveBeenCalled();
    expect(harness.dealFindOne).not.toHaveBeenCalled();
  });
});

describe('entity Coupon population', () => {
  it('keeps Coupons category-scoped and populates the ordered Store logo reference', async () => {
    const harness = createHarness();
    harness.ctx.state.entityType = 'category';
    // Members exist but the mocked entity has no drag-ordered `coupons`
    // relation → all offers come from the newest-first member query.
    harness.couponCount.mockResolvedValue(3);

    await harness.controller.getCouponsByEntity(harness.ctx as any);

    const options = harness.couponFindMany.mock.calls[0]?.[0];
    expect(options.filters.categories.documentId).toBe('store-amazon');
    expect(options.populate.stores).toEqual({
      fields: ['name', 'slug', 'logoAlt'],
      populate: { logo: true },
    });
    expect(options.populate.brands).toEqual({
      fields: ['name', 'slug', 'logoAlt'],
      populate: { logo: true },
    });
    // The entity query also reads the drag-ordered coupon ids (published only).
    const entityPopulate = harness.entityFindMany.mock.calls[0]?.[0].populate;
    expect(entityPopulate.icon).toBe(true);
    expect(entityPopulate.faqs).toBe(true);
    expect(entityPopulate.seo).toEqual({ populate: { ogImage: true } });
    expect(entityPopulate.coupons.fields).toEqual(['documentId']);
    expect(entityPopulate.topPickCoupons).toEqual({
      fields: ['documentId'],
      filters: expect.any(Object),
    });
  });

  it('hydrates visible Top Pick Coupons in entity selection order', async () => {
    const harness = createHarness();
    // Simulate an authenticated server token whose core Coupon.find scope
    // makes Strapi remove the nested relation from an entity query. The custom
    // public endpoint must restore its reviewed ID-only projection.
    harness.sanitizeQuery.mockImplementation(async (query: any) => {
      if (!query.populate?.topPickCoupons) return query;
      const populate = { ...query.populate };
      delete populate.topPickCoupons;
      return { ...query, populate };
    });
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        topPickCoupons: [
          { documentId: 'coupon-second' },
          { documentId: 'coupon-first' },
        ],
        coupons: [],
      },
    ]);
    harness.couponFindMany.mockResolvedValueOnce([
      {
        documentId: 'coupon-first',
        title: 'First',
        couponType: 'static',
        code: 'FIRST',
      },
      {
        documentId: 'coupon-second',
        title: 'Second',
        couponType: 'static',
        code: 'SECOND',
      },
    ]);

    const payload = await harness.controller.getCouponsByEntity(
      harness.ctx as any,
    );

    expect(payload.store.topPickCoupons.map((coupon: any) => coupon.documentId))
      .toEqual(['coupon-second', 'coupon-first']);
    const topPickQuery = harness.couponFindMany.mock.calls[0]?.[0];
    expect(topPickQuery).toMatchObject({
      fields: expect.arrayContaining([
        'title',
        'couponType',
        'affiliateLink',
        'publishedOn',
      ]),
      filters: {
        documentId: { $in: ['coupon-second', 'coupon-first'] },
      },
      populate: {
        image: true,
        stores: expect.any(Object),
        banks: expect.any(Object),
        categories: expect.any(Object),
        brands: expect.any(Object),
        uniqueCouponPool: { fields: ['name'] },
      },
      limit: 2,
    });
  });

  it('returns the same hydrated Top Picks from the Deal entity endpoint', async () => {
    const harness = createHarness();
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        topPickCoupons: [{ documentId: 'coupon-featured' }],
        deals: [],
      },
    ]);
    harness.couponFindMany.mockResolvedValue([
      {
        documentId: 'coupon-featured',
        title: 'Featured',
        affiliateLink: 'https://partner.example.com/featured',
      },
    ]);

    const payload = await harness.controller.getDealsByEntity(
      harness.ctx as any,
    );

    expect(payload.store.topPickCoupons).toEqual([
      expect.objectContaining({
        documentId: 'coupon-featured',
        title: 'Featured',
      }),
    ]);
  });

  it('returns coupons in the entity relation (drag) order, hydrated by id', async () => {
    const harness = createHarness();
    // Entity edit page has these coupons dragged into this order.
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        coupons: [{ documentId: 'c-second' }, { documentId: 'c-first' }],
      },
    ]);
    // Hydration returns them in an arbitrary order — the controller must
    // re-apply the relation order.
    harness.couponFindMany.mockResolvedValue([
      { documentId: 'c-first', title: 'First' },
      { documentId: 'c-second', title: 'Second' },
    ]);

    const payload = await harness.controller.getCouponsByEntity(harness.ctx as any);

    // Hydration filtered by the paged relation ids, in order.
    const hydrationQuery = harness.couponFindMany.mock.calls[0]?.[0];
    expect(hydrationQuery.filters.documentId.$in).toEqual(['c-second', 'c-first']);
    // Response preserves the drag order; total comes from the relation.
    expect(payload.coupons.map((c: any) => c.documentId)).toEqual([
      'c-second',
      'c-first',
    ]);
    expect(payload.pagination.total).toBe(2);
  });

  it('keeps the ordered relation populate compatible with Document Service validation', async () => {
    const harness = createHarness();

    await harness.controller.getCouponsByEntity(harness.ctx as any);

    // Strapi rejects nested `limit` with "Invalid key limit at coupons".
    // The controller caps the ID-only relation in JavaScript after fetching it.
    const entityQuery = harness.entityFindMany.mock.calls[0]?.[0];
    expect(entityQuery.populate.coupons).toMatchObject({
      fields: ['documentId'],
    });
    expect(entityQuery.populate.coupons.limit).toBeUndefined();
    expect(entityQuery.populate.topPickCoupons.limit).toBeUndefined();
  });

  it('caps the curated head so newly tagged offers stay inside the frontend read window', async () => {
    const harness = createHarness();
    harness.ctx.state.entityType = 'category';
    harness.ctx.query.pageSize = '50';
    // A large category: 120 coupons dragged into the relation. Strapi appends
    // newly connected coupons at the tail, so without a cap the newest ones sit
    // past page 2 — outside the frontend's 4-page window.
    const orderedIds = Array.from({ length: 120 }, (_, index) =>
      `c-${String(index).padStart(3, '0')}`,
    );
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'category-articles',
        name: 'Articles',
        slug: 'articles',
        coupons: orderedIds.map((documentId) => ({ documentId })),
      },
    ]);
    // The 70 members displaced out of the curated head become "rest".
    harness.couponCount.mockResolvedValue(70);
    harness.couponFindMany.mockResolvedValue(
      orderedIds.slice(0, 50).map((documentId) => ({ documentId, title: documentId })),
    );

    const payload = await harness.controller.getCouponsByEntity(harness.ctx as any);

    // Only the first 50 drag positions are hydrated.
    const hydrationQuery = harness.couponFindMany.mock.calls[0]?.[0];
    expect(hydrationQuery.filters.documentId.$in).toHaveLength(50);
    expect(hydrationQuery.filters.documentId.$in[0]).toBe('c-000');
    expect(hydrationQuery.filters.documentId.$in[49]).toBe('c-049');
    // The $notIn exclusion shrinks from 120 to 50 elements — the query-cost
    // shape that previously produced 504s on this database.
    const restCountQuery = harness.couponCount.mock.calls[0]?.[0];
    expect(restCountQuery.filters.documentId.$notIn).toHaveLength(50);
    // Membership is unchanged: the displaced 70 are still counted and reachable.
    expect(payload.coupons).toHaveLength(50);
    expect(payload.pagination.total).toBe(120);
  });

  it('leaves an entity below the cap behaving exactly as before', async () => {
    const harness = createHarness();
    harness.ctx.state.entityType = 'category';
    const orderedIds = Array.from({ length: 10 }, (_, index) => `c-${index}`);
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'category-small',
        name: 'Small',
        slug: 'small',
        coupons: orderedIds.map((documentId) => ({ documentId })),
      },
    ]);
    harness.couponCount.mockResolvedValue(0);
    harness.couponFindMany.mockResolvedValue(
      orderedIds.map((documentId) => ({ documentId, title: documentId })),
    );

    const payload = await harness.controller.getCouponsByEntity(harness.ctx as any);

    // Every drag position is honoured — nothing is truncated below the cap.
    const hydrationQuery = harness.couponFindMany.mock.calls[0]?.[0];
    expect(hydrationQuery.filters.documentId.$in).toEqual(orderedIds);
    const restCountQuery = harness.couponCount.mock.calls[0]?.[0];
    expect(restCountQuery.filters.documentId.$notIn).toEqual(orderedIds);
    expect(payload.coupons.map((c: any) => c.documentId)).toEqual(orderedIds);
    expect(payload.pagination.total).toBe(10);
  });
});

describe('entity product Deal population', () => {
  it('populates nested owner logos for the shared Deal card', async () => {
    const harness = createHarness();
    harness.dealCount.mockResolvedValue(3); // members exist → member query runs

    await harness.controller.getDealsByEntity(harness.ctx as any);

    const options = harness.dealFindMany.mock.calls[0]?.[0];
    const logoRef = {
      fields: ['name', 'slug', 'logoAlt'],
      populate: { logo: true },
    };
    expect(options.populate.stores).toEqual(logoRef);
    expect(options.populate.brands).toEqual(logoRef);
    expect(options.populate.banks).toEqual(logoRef);
    expect(options.populate.categories).toEqual({
      fields: ['name', 'slug', 'iconAlt'],
      populate: { icon: true },
    });
    // A deal's store membership is the `stores` taxonomy alone — the old
    // `primaryStore` $or arm is gone with the field.
    expect(options.filters.stores).toEqual({ documentId: 'store-amazon' });
    expect(options.filters).not.toHaveProperty('$or');
    // With no curated entity.deals selection, related product Deals are the
    // newest published records first before the UI builds its Deal rail.
    // `publishedOn` leads: it is the editor-controlled sort key, with Strapi's
    // own `publishedAt` only breaking ties for rows the backfill missed.
    expect(options.sort).toEqual([
      { publishedOn: 'desc' },
      { publishedAt: 'desc' },
      { updatedAt: 'desc' },
    ]);
  });

  it('keeps the Deal relation populate compatible with Document Service validation', async () => {
    const harness = createHarness();

    await harness.controller.getDealsByEntity(harness.ctx as any);

    const entityQuery = harness.entityFindMany.mock.calls[0]?.[0];
    expect(entityQuery.populate.deals).toMatchObject({
      fields: ['documentId'],
    });
    expect(entityQuery.populate.deals.limit).toBeUndefined();
  });

  it('appends store-taxonomy deals missing from the drag-ordered relation', async () => {
    const harness = createHarness();
    // Store edit page: one deal is in the ordered `deals` relation...
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        deals: [{ documentId: 'd-relation' }],
      },
    ]);
    // ...and one deal carries the store in its `stores` taxonomy without
    // appearing in that ordered relation — the two can diverge — so it must
    // still be counted and appended after the ordered head.
    harness.dealCount.mockResolvedValue(1);
    harness.dealFindMany
      .mockResolvedValueOnce([{ documentId: 'd-relation', title: 'Relation' }]) // ordered hydration
      .mockResolvedValueOnce([{ documentId: 'd-taxonomy', title: 'Taxonomy' }]); // rest (newest-first)

    const payload = await harness.controller.getDealsByEntity(harness.ctx as any);

    // The rest query excludes the ordered ids and uses the store membership.
    const restQuery = harness.dealFindMany.mock.calls[1]?.[0];
    expect(restQuery.filters.documentId.$notIn).toEqual(['d-relation']);
    expect(restQuery.filters.stores).toEqual({ documentId: 'store-amazon' });
    // Ordered head first, then the taxonomy-only deal; total counts both.
    expect(payload.deals.map((d: any) => d.documentId)).toEqual(['d-relation', 'd-taxonomy']);
    expect(payload.pagination.total).toBe(2);
  });
});
