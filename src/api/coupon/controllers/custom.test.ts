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
          salePrice: index === 0 ? null : 999 + index,
          mrp: index === 0 ? null : 1999 + index,
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
    expect(payload.relatedDeals[0].salePrice).toBeNull();
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

  it('redacts a legacy shared code left on a unique Coupon', async () => {
    // Rows predating normaliseCouponTypeFields still carry the code they had
    // before the type flipped. It is never the code a visitor gets — those come
    // one at a time out of the pool — so it must not reach the wire.
    const harness = createHarness();
    harness.ctx.params = {
      entityType: 'coupon',
      documentId: 'coupon-document-1',
    } as any;
    harness.couponFindOne.mockResolvedValue({
      documentId: 'coupon-document-1',
      title: 'Save 20%',
      couponType: 'unique',
      code: 'LEGACY-SHARED-CODE',
      uniqueCouponPool: { documentId: 'pool-1' },
    });

    const payload = await harness.controller.getRedeemOffer(harness.ctx as any);

    expect(payload.data.code).toBeNull();
  });

  it('leaves a static Coupon code untouched', async () => {
    const harness = createHarness();
    harness.ctx.params = {
      entityType: 'coupon',
      documentId: 'coupon-document-1',
    } as any;
    harness.couponFindOne.mockResolvedValue({
      documentId: 'coupon-document-1',
      title: 'Save 20%',
      couponType: 'static',
      code: 'SAVE20',
    });

    const payload = await harness.controller.getRedeemOffer(harness.ctx as any);

    expect(payload.data.code).toBe('SAVE20');
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
  it('adds a safe last-update attribution projection to the entity response', async () => {
    const harness = createHarness();
    harness.entityFindMany.mockResolvedValue([
      {
        id: 47,
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        updatedAt: '2026-03-24T10:00:00.000Z',
      },
    ]);

    const payload = await harness.controller.getCouponsByEntity(
      harness.ctx as any,
    );

    expect(payload.store).toMatchObject({
      lastUpdatedAt: '2026-03-24T10:00:00.000Z',
      lastUpdatedByName: 'CouponzGuru Team',
    });
    expect(payload.store).not.toHaveProperty('updatedBy');
  });

  it('keeps Coupons category-scoped and populates the ordered Store logo reference', async () => {
    const harness = createHarness();
    harness.ctx.state.entityType = 'category';
    // Members exist but the mocked entity has no `orderedCoupons`
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
    // The entity query also reads the selected Coupon ids (published only).
    const entityPopulate = harness.entityFindMany.mock.calls[0]?.[0].populate;
    expect(entityPopulate.icon).toBe(true);
    expect(entityPopulate.faqs).toBe(true);
    expect(entityPopulate.seo).toEqual({ populate: { ogImage: true } });
    expect(entityPopulate).not.toHaveProperty('coupons');
    expect(entityPopulate.orderedCoupons).toEqual({
      fields: ['documentId'],
      filters: expect.objectContaining({
        categories: { slug: 'amazon-coupons' },
      }),
    });
    expect(entityPopulate.topPickCoupons).toEqual({
      fields: ['documentId'],
      filters: expect.objectContaining({
        categories: { slug: 'amazon-coupons' },
      }),
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
        stores: { slug: 'amazon-coupons' },
      },
      populate: {
        stores: expect.any(Object),
        banks: expect.any(Object),
        categories: expect.any(Object),
        brands: expect.any(Object),
        uniqueCouponPool: { fields: ['name'] },
      },
      limit: 2,
    });
  });

  it.each([
    ['store', 'stores'],
    ['brand', 'brands'],
    ['category', 'categories'],
    ['bank', 'banks'],
  ] as const)(
    'requires a Top Pick to retain its %s membership in both lookup stages',
    async (entityType, relationField) => {
      const harness = createHarness();
      harness.ctx.state.entityType = entityType;
      harness.entityFindMany.mockResolvedValue([
        {
          documentId: `${entityType}-amazon`,
          name: 'Amazon',
          slug: 'amazon-coupons',
          topPickCoupons: [{ documentId: 'coupon-featured' }],
        },
      ]);
      harness.couponFindMany.mockResolvedValueOnce([
        { documentId: 'coupon-featured', title: 'Featured' },
      ]);

      await harness.controller.getCouponsByEntity(harness.ctx as any);

      const entityQuery = harness.entityFindMany.mock.calls[0]?.[0];
      expect(entityQuery.populate.topPickCoupons.filters[relationField]).toEqual(
        { slug: 'amazon-coupons' },
      );
      const hydrationQuery = harness.couponFindMany.mock.calls[0]?.[0];
      expect(hydrationQuery.filters[relationField]).toEqual({
        slug: 'amazon-coupons',
      });
    },
  );

  it('keeps Coupon curation out of the Deal entity endpoint', async () => {
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
    const payload = await harness.controller.getDealsByEntity(
      harness.ctx as any,
    );

    expect(payload.store).not.toHaveProperty('topPickCoupons');
    expect(payload.store).not.toHaveProperty('orderedCouponIds');
    expect(harness.entityFindMany.mock.calls[0]?.[0].populate)
      .not.toHaveProperty('topPickCoupons');
    expect(harness.couponFindMany).not.toHaveBeenCalled();
  });

  it('returns selected Coupons in orderedCoupons order, hydrated by id', async () => {
    const harness = createHarness();
    // The entity editor selected these Coupons in this explicit order.
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        orderedCoupons: [
          { documentId: 'c-second' },
          { documentId: 'c-first' },
        ],
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
    // Response preserves the editorial order.
    expect(payload.coupons.map((c: any) => c.documentId)).toEqual([
      'c-second',
      'c-first',
    ]);
    expect(payload.store.orderedCouponIds).toEqual([
      'c-second',
      'c-first',
    ]);
    expect(payload.pagination.total).toBe(2);
  });

  it('keeps the ordered relation populate compatible with Document Service validation', async () => {
    const harness = createHarness();

    await harness.controller.getCouponsByEntity(harness.ctx as any);

    // Strapi rejects nested `limit` with "Invalid key limit at orderedCoupons".
    // The controller caps the ID-only relation in JavaScript after fetching it.
    const entityQuery = harness.entityFindMany.mock.calls[0]?.[0];
    expect(entityQuery.populate.orderedCoupons).toMatchObject({
      fields: ['documentId'],
    });
    expect(entityQuery.populate.orderedCoupons.limit).toBeUndefined();
    expect(entityQuery.populate).not.toHaveProperty('coupons');
    expect(entityQuery.populate.topPickCoupons.limit).toBeUndefined();
  });

  it('prepends at most ten selected Coupons without limiting full membership', async () => {
    const harness = createHarness();
    harness.ctx.state.entityType = 'category';
    harness.ctx.query.pageSize = '50';
    const selectedIds = Array.from({ length: 11 }, (_, index) =>
      `c-${String(index).padStart(3, '0')}`,
    );
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'category-articles',
        name: 'Articles',
        slug: 'articles',
        orderedCoupons: selectedIds.map((documentId) => ({ documentId })),
      },
    ]);
    // There are 90 additional taxonomy members outside the editorial ten.
    harness.couponCount.mockResolvedValue(90);
    harness.couponFindMany.mockResolvedValue(
      selectedIds
        .slice(0, 10)
        .map((documentId) => ({ documentId, title: documentId })),
    );

    const payload = await harness.controller.getCouponsByEntity(harness.ctx as any);

    const hydrationQuery = harness.couponFindMany.mock.calls[0]?.[0];
    expect(hydrationQuery.filters.documentId.$in).toHaveLength(10);
    expect(hydrationQuery.filters.documentId.$in[0]).toBe('c-000');
    expect(hydrationQuery.filters.documentId.$in[9]).toBe('c-009');
    const restCountQuery = harness.couponCount.mock.calls[0]?.[0];
    expect(restCountQuery.filters.documentId.$notIn).toHaveLength(10);
    expect(payload.pagination.total).toBe(100);
  });

  it('appends every unselected member newest-first after the ordered Coupons', async () => {
    const harness = createHarness();
    harness.ctx.state.entityType = 'category';
    const orderedIds = ['c-7', 'c-2', 'c-91'];
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'category-small',
        name: 'Small',
        slug: 'small',
        orderedCoupons: orderedIds.map((documentId) => ({ documentId })),
      },
    ]);
    harness.couponCount.mockResolvedValue(2);
    harness.couponFindMany
      .mockResolvedValueOnce(
        [...orderedIds]
          .reverse()
          .map((documentId) => ({ documentId, title: documentId })),
      )
      .mockResolvedValueOnce([
        { documentId: 'c-latest', title: 'Latest' },
        { documentId: 'c-older', title: 'Older' },
      ]);

    const payload = await harness.controller.getCouponsByEntity(harness.ctx as any);

    const hydrationQuery = harness.couponFindMany.mock.calls[0]?.[0];
    expect(hydrationQuery.filters.documentId.$in).toEqual(orderedIds);
    const restCountQuery = harness.couponCount.mock.calls[0]?.[0];
    expect(restCountQuery.filters.documentId.$notIn).toEqual(orderedIds);
    const restQuery = harness.couponFindMany.mock.calls[1]?.[0];
    expect(restQuery.sort).toEqual([
      { publishedOn: 'desc' },
      { publishedAt: 'desc' },
      { updatedAt: 'desc' },
    ]);
    expect(payload.coupons.map((c: any) => c.documentId)).toEqual([
      ...orderedIds,
      'c-latest',
      'c-older',
    ]);
    expect(payload.pagination.total).toBe(5);
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

  it('does not read an entity-side Deal ordering relation', async () => {
    const harness = createHarness();

    await harness.controller.getDealsByEntity(harness.ctx as any);

    const entityQuery = harness.entityFindMany.mock.calls[0]?.[0];
    expect(entityQuery.populate).not.toHaveProperty('deals');
    expect(entityQuery.populate).not.toHaveProperty('orderedCoupons');
  });

  it('returns all taxonomy Deals newest-first even if a legacy deals relation exists', async () => {
    const harness = createHarness();
    harness.entityFindMany.mockResolvedValue([
      {
        documentId: 'store-amazon',
        name: 'Amazon',
        slug: 'amazon-coupons',
        deals: [{ documentId: 'd-legacy-relation' }],
      },
    ]);
    harness.dealCount.mockResolvedValue(2);
    harness.dealFindMany.mockResolvedValue([
      { documentId: 'd-newest', title: 'Newest' },
      { documentId: 'd-older', title: 'Older' },
    ]);

    const payload = await harness.controller.getDealsByEntity(harness.ctx as any);

    expect(harness.dealFindMany).toHaveBeenCalledTimes(1);
    const query = harness.dealFindMany.mock.calls[0]?.[0];
    expect(query.filters).not.toHaveProperty('documentId');
    expect(query.filters.stores).toEqual({ documentId: 'store-amazon' });
    expect(query.sort).toEqual([
      { publishedOn: 'desc' },
      { publishedAt: 'desc' },
      { updatedAt: 'desc' },
    ]);
    expect(payload.deals.map((d: any) => d.documentId)).toEqual([
      'd-newest',
      'd-older',
    ]);
    expect(payload.pagination.total).toBe(2);
  });
});
