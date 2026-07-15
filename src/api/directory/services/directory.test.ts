import { describe, expect, it } from 'vitest';
import createDirectoryService from './directory';

type Fixture = Record<string, any[]>;

function createHarness(fixture: Fixture) {
  const calls: Array<{ uid: string; options: any }> = [];
  const strapi = {
    documents(uid: string) {
      return {
        async findMany(options: any) {
          calls.push({ uid, options });
          const source = fixture[uid] ?? [];
          if (
            (options.populate?.logo || options.populate?.icon) &&
            options.filters?.documentId?.$in
          ) {
            const ids = new Set(options.filters?.documentId?.$in ?? []);
            return source.filter((document) => ids.has(document.documentId));
          }
          const start = options.start ?? 0;
          const limit = options.limit ?? source.length;
          return source.slice(start, start + limit);
        },
      };
    },
  } as any;

  return {
    calls,
    service: createDirectoryService({ strapi }),
  };
}

const stores = [
  {
    documentId: 'store-alpha',
    name: 'Alpha',
    slug: 'alpha-coupons',
    logoAlt: 'Alpha logo',
    logo: {
      url: '/uploads/alpha.webp',
      alternativeText: 'Alpha mark',
      width: 160,
      height: 80,
      formats: {
        small: { url: '/uploads/small_alpha.webp', width: 80, height: 40 },
      },
    },
  },
  {
    documentId: 'store-beta',
    name: 'Beta',
    slug: 'beta-coupons',
    logo: null,
  },
  { documentId: 'store-empty', name: 'Empty', slug: 'empty-coupons' },
  { documentId: 'store-invalid', name: 'Invalid', slug: '  ' },
];

describe('directory aggregate service', () => {
  it('keeps Coupon and product Deal inventory separate and ranks by live counts', async () => {
    const { calls, service } = createHarness({
      'api::store.store': stores,
      'api::coupon.coupon': [
        {
          documentId: 'coupon-one',
          publishedAt: '2026-07-10T00:00:00.000Z',
          stores: [stores[0]],
        },
        {
          documentId: 'coupon-two',
          publishedAt: '2026-07-11T00:00:00.000Z',
          stores: [stores[0], stores[1]],
        },
      ],
      'api::deal.deal': [
        {
          documentId: 'deal-one',
          publishedAt: '2026-07-12T00:00:00.000Z',
          stores: [stores[1]],
        },
      ],
    });

    const response = await service.getDirectory('store');

    expect(response.totals).toEqual({
      entityCount: 3,
      couponCount: 2,
      productDealCount: 1,
    });
    expect(response.items).toEqual([
      expect.objectContaining({
        name: 'Alpha',
        couponCount: 2,
        productDealCount: 0,
        media: expect.objectContaining({ url: '/uploads/alpha.webp' }),
        mediaAlt: 'Alpha logo',
      }),
      expect.objectContaining({
        name: 'Beta',
        couponCount: 1,
        productDealCount: 1,
        media: null,
        mediaAlt: 'Beta',
      }),
      expect.objectContaining({
        name: 'Empty',
        couponCount: 0,
        productDealCount: 0,
      }),
    ]);
    expect(response.popular).toEqual([
      expect.objectContaining({
        documentId: 'store-beta',
        couponCount: 1,
        productDealCount: 1,
        media: null,
        mediaAlt: 'Beta',
      }),
      expect.objectContaining({
        documentId: 'store-alpha',
        couponCount: 2,
        productDealCount: 0,
        mediaAlt: 'Alpha logo',
        media: expect.objectContaining({ url: '/uploads/alpha.webp' }),
      }),
    ]);
    expect(
      response.popular.some((item: any) => item.documentId === 'store-empty'),
    ).toBe(false);

    const offerCalls = calls.filter(({ uid }) =>
      ['api::coupon.coupon', 'api::deal.deal'].includes(uid),
    );
    for (const { options } of offerCalls) {
      expect(options.filters.contentStatus).toEqual({ $eq: 'published' });
      expect(options.filters.$and[0].$or).toEqual([
        { expiresAt: { $null: true } },
        { expiresAt: { $gt: expect.any(String) } },
      ]);
    }
    const couponCall = offerCalls.find(({ uid }) => uid === 'api::coupon.coupon');
    const dealCall = offerCalls.find(({ uid }) => uid === 'api::deal.deal');
    expect(couponCall?.options.filters).not.toHaveProperty('primaryStore');
    expect(couponCall?.options.filters).not.toHaveProperty('$or');
    expect(dealCall?.options.filters.$or).toContainEqual({
      primaryStore: { documentId: { $notNull: true } },
    });
  });

  it('deduplicates a Deal owner present in both stores and primaryStore', async () => {
    const { service } = createHarness({
      'api::store.store': stores.slice(0, 2),
      'api::coupon.coupon': [],
      'api::deal.deal': [
        {
          documentId: 'deal-shared-owner',
          publishedAt: '2026-07-12T00:00:00.000Z',
          stores: [stores[0], stores[0]],
          primaryStore: stores[0],
        },
        {
          documentId: 'deal-shared-across-entities',
          publishedAt: '2026-07-13T00:00:00.000Z',
          stores: [stores[0], stores[1]],
        },
      ],
    });

    const response = await service.getDirectory('store');

    expect(response.totals.productDealCount).toBe(2);
    expect(response.popular).toEqual([
      expect.objectContaining({
        documentId: 'store-alpha',
        productDealCount: 2,
      }),
      expect.objectContaining({
        documentId: 'store-beta',
        productDealCount: 1,
      }),
    ]);
  });

  it('uses newest related publication, then name, as deterministic tie breakers', async () => {
    const { service } = createHarness({
      'api::store.store': stores.slice(0, 2),
      'api::coupon.coupon': [
        {
          documentId: 'coupon-alpha',
          publishedAt: '2026-07-10T00:00:00.000Z',
          stores: [stores[0]],
        },
        {
          documentId: 'coupon-beta',
          publishedAt: '2026-07-11T00:00:00.000Z',
          stores: [stores[1]],
        },
      ],
      'api::deal.deal': [],
    });

    const response = await service.getDirectory('store');
    expect(response.popular.map((item: any) => item.documentId)).toEqual([
      'store-beta',
      'store-alpha',
    ]);
  });

  it('normalizes category icon media into the common media field', async () => {
    const category = {
      documentId: 'category-travel',
      name: 'Travel',
      slug: 'travel',
      icon: {
        url: '/uploads/travel.svg',
        alternativeText: 'Travel category',
      },
    };
    const { service } = createHarness({
      'api::category.category': [category],
      'api::coupon.coupon': [
        {
          documentId: 'coupon-travel',
          publishedAt: '2026-07-11T00:00:00.000Z',
          categories: [category],
        },
      ],
      'api::deal.deal': [],
    });

    const response = await service.getDirectory('category');
    expect(response.popular[0]).toMatchObject({
      media: { url: '/uploads/travel.svg' },
      mediaAlt: 'Travel category',
    });
    expect(response.items[0]).toMatchObject({
      media: { url: '/uploads/travel.svg' },
      mediaAlt: 'Travel category',
      couponCount: 1,
      productDealCount: 0,
    });
  });

  it('returns an empty, well-formed directory when no valid documents exist', async () => {
    const { service } = createHarness({
      'api::category.category': [
        { documentId: 'bad', name: '', slug: 'bad' },
      ],
      'api::coupon.coupon': [],
      'api::deal.deal': [],
    });

    const response = await service.getDirectory('category');
    expect(response).toMatchObject({
      kind: 'category',
      totals: { entityCount: 0, couponCount: 0, productDealCount: 0 },
      popular: [],
      items: [],
    });
    expect(Date.parse(response.generatedAt)).not.toBeNaN();
  });

  it('reads past a full batch and terminates after the empty trailing page', async () => {
    const allStores = Array.from({ length: 1_000 }, (_, index) => ({
      documentId: `store-${index}`,
      name: `Store ${index}`,
      slug: `store-${index}`,
    }));
    const { calls, service } = createHarness({
      'api::store.store': allStores,
      'api::coupon.coupon': [],
      'api::deal.deal': [],
    });

    const response = await service.getDirectory('store');

    expect(response.items).toHaveLength(1_000);
    expect(
      calls
        .filter(
          ({ uid, options }) =>
            uid === 'api::store.store' &&
            !options.filters?.documentId?.$in,
        )
        .map(({ options }) => options.start),
    ).toEqual([0, 1_000]);
  });
});
