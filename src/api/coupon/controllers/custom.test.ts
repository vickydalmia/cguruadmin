import { afterEach, describe, expect, it, vi } from 'vitest';

import createCouponController from './custom';

const REDEEM_TEST_SECRET = 'redeem-test-secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

function createHarness() {
  vi.stubEnv('ISR_REVALIDATE_SECRET', REDEEM_TEST_SECRET);

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
  };
}

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
    expect(entityPopulate.topPickCoupons).toMatchObject({
      fields: expect.arrayContaining(['title', 'couponType', 'affiliateLink']),
      populate: {
        image: true,
        stores: expect.any(Object),
        banks: expect.any(Object),
        categories: expect.any(Object),
        brands: expect.any(Object),
        uniqueCouponPool: { fields: ['name'] },
      },
    });
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
    expect(options.populate.primaryStore).toEqual(logoRef);
    expect(options.populate.stores).toEqual(logoRef);
    expect(options.populate.brands).toEqual(logoRef);
    expect(options.populate.banks).toEqual(logoRef);
    expect(options.populate.categories).toEqual({
      fields: ['name', 'slug'],
      populate: { icon: true },
    });
    expect(options.filters.$or).toEqual([
      { stores: { documentId: 'store-amazon' } },
      { primaryStore: { documentId: 'store-amazon' } },
    ]);
    // With no curated entity.deals selection, related product Deals are the
    // newest published records first before the UI builds its Deal rail.
    expect(options.sort).toEqual([
      { publishedAt: 'desc' },
      { updatedAt: 'desc' },
    ]);
  });

  it('appends primaryStore-only deals after the drag-ordered relation', async () => {
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
    // ...and one deal belongs to the store only via primaryStore (not in the
    // relation), so it must still be counted and appended after the ordered head.
    harness.dealCount.mockResolvedValue(1);
    harness.dealFindMany
      .mockResolvedValueOnce([{ documentId: 'd-relation', title: 'Relation' }]) // ordered hydration
      .mockResolvedValueOnce([{ documentId: 'd-primary', title: 'Primary' }]); // rest (newest-first)

    const payload = await harness.controller.getDealsByEntity(harness.ctx as any);

    // The rest query excludes the ordered ids and uses the store $or membership.
    const restQuery = harness.dealFindMany.mock.calls[1]?.[0];
    expect(restQuery.filters.documentId.$notIn).toEqual(['d-relation']);
    expect(restQuery.filters.$or).toEqual([
      { stores: { documentId: 'store-amazon' } },
      { primaryStore: { documentId: 'store-amazon' } },
    ]);
    // Ordered head first, then the primary-only deal; total counts both.
    expect(payload.deals.map((d: any) => d.documentId)).toEqual(['d-relation', 'd-primary']);
    expect(payload.pagination.total).toBe(2);
  });
});
