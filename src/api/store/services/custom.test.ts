import { beforeEach, describe, expect, it, vi } from 'vitest';
import createStoreService from './custom';

type FindManyMock = ReturnType<typeof vi.fn>;

const currentStore = {
  id: 1,
  documentId: 'store-current',
  name: 'Current Store',
  slug: 'current-store',
  logo: { url: '/current.png' },
  logoAlt: 'Current Store logo',
};

function category(documentId: string, slug = documentId) {
  return { documentId, name: slug, slug };
}

function store(documentId: string, name: string, slug = name.toLowerCase()) {
  return { documentId, name, slug };
}

function hydratedStore(candidate: ReturnType<typeof store>) {
  return {
    ...candidate,
    id: Number(candidate.documentId.replace(/\D/gu, '')) || undefined,
    logo: {
      url: `/${candidate.slug}.png`,
      width: 240,
      height: 240,
      formats: { thumbnail: { url: `/${candidate.slug}-thumbnail.png` } },
    },
    logoAlt: `${candidate.name} logo`,
  };
}

function createHarness() {
  const findManyByUid: Record<string, FindManyMock> = {
    'api::store.store': vi.fn(),
    'api::brand.brand': vi.fn(),
    'api::category.category': vi.fn(),
    'api::bank.bank': vi.fn(),
    'api::coupon.coupon': vi.fn(),
    'api::deal.deal': vi.fn(),
  };
  const documents = vi.fn((uid: string) => ({
    findMany: findManyByUid[uid],
  }));
  const strapi = { documents } as any;

  return {
    findManyByUid,
    service: createStoreService({ strapi }),
  };
}

function givenCurrentStore(harness: ReturnType<typeof createHarness>) {
  harness.findManyByUid['api::store.store'].mockResolvedValueOnce([
    currentStore,
  ]);
}

function givenRelatedOffers(
  harness: ReturnType<typeof createHarness>,
  coupons: any[] = [],
  deals: any[] = [],
) {
  harness.findManyByUid['api::coupon.coupon'].mockResolvedValueOnce(coupons);
  harness.findManyByUid['api::deal.deal'].mockResolvedValueOnce(deals);
}

function givenHydratedStores(
  harness: ReturnType<typeof createHarness>,
  stores: any[],
) {
  harness.findManyByUid['api::store.store'].mockResolvedValueOnce(stores);
}

describe('store custom service relatedStores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the requested store does not exist', async () => {
    const harness = createHarness();
    harness.findManyByUid['api::store.store'].mockResolvedValueOnce([]);

    await expect(
      harness.service.relatedStores('store', 'missing', {
        categoryDocumentIds: 'cat-a',
      }),
    ).resolves.toBeNull();

    expect(harness.findManyByUid['api::coupon.coupon']).not.toHaveBeenCalled();
    expect(harness.findManyByUid['api::deal.deal']).not.toHaveBeenCalled();
  });

  it('uses the Store fallback without querying offer inventory when the caller confirms an empty category set', async () => {
    const harness = createHarness();
    const fallback = store('store-2', 'Fallback Store', 'fallback-store');
    givenCurrentStore(harness);
    givenHydratedStores(harness, [
      hydratedStore(currentStore),
      store('store-3', 'Missing Artwork', 'missing-artwork'),
      hydratedStore(fallback),
    ]);

    await expect(
      harness.service.relatedStores('store', 'current-store', {
        categorySource: 'storeOffers',
      }),
    ).resolves.toEqual({
      store: {
        ...currentStore,
        offerCount: 0,
        sharedCategoryCount: 0,
      },
      stores: [
        expect.objectContaining({
          slug: 'fallback-store',
          offerCount: 0,
          sharedCategoryCount: 0,
        }),
      ],
    });

    expect(harness.findManyByUid['api::store.store']).toHaveBeenCalledTimes(2);
    expect(
      harness.findManyByUid['api::store.store'].mock.calls[1]?.[0],
    ).toMatchObject({
      sort: [
        { ratingAverage: 'desc' },
        { ratingCount: 'desc' },
        { updatedAt: 'desc' },
        { name: 'asc' },
      ],
      limit: 24,
    });
    expect(harness.findManyByUid['api::coupon.coupon']).not.toHaveBeenCalled();
    expect(harness.findManyByUid['api::deal.deal']).not.toHaveBeenCalled();
  });

  it('derives fallback categories from Coupons and Deals related through stores', async () => {
    const harness = createHarness();
    const couponFindMany = harness.findManyByUid['api::coupon.coupon'];
    const dealFindMany = harness.findManyByUid['api::deal.deal'];
    givenCurrentStore(harness);
    couponFindMany
      .mockResolvedValueOnce([{ categories: [category('cat-a')] }])
      .mockResolvedValueOnce([]);
    dealFindMany
      .mockResolvedValueOnce([{ categories: [category('cat-b')] }])
      .mockResolvedValueOnce([]);

    await expect(
      harness.service.relatedStores('store', 'current-store'),
    ).resolves.toMatchObject({ stores: [] });

    // publishedOnlyFilters(): status check plus a $and-wrapped expiry window.
    // The wrapper exists so it can never clobber a caller's own top-level $or;
    // no offer filter needs one now that `primaryStore` is gone, but the shape
    // is unchanged and other call sites still rely on it.
    const publishedShape = {
      contentStatus: { $eq: 'published' },
      $and: [
        {
          $or: [{ expiresAt: { $null: true } }, { expiresAt: { $gt: expect.any(String) } }],
        },
      ],
    };
    expect(couponFindMany.mock.calls[0]?.[0].filters).toEqual({
      stores: { documentId: 'store-current' },
      ...publishedShape,
    });
    expect(dealFindMany.mock.calls[0]?.[0].filters).toEqual({
      stores: { documentId: 'store-current' },
      ...publishedShape,
    });
    expect(couponFindMany.mock.calls[1]?.[0].filters).toEqual({
      categories: { documentId: { $in: ['cat-a', 'cat-b'] } },
      ...publishedShape,
    });
  });

  it.each([
    ['brand', 'api::brand.brand', 'brands'],
    ['bank', 'api::bank.bank', 'banks'],
  ] as const)(
    'derives %s categories from active Coupons and Product Deals and returns Stores only',
    async (entityType, uid, relationField) => {
      const harness = createHarness();
      const source = {
        documentId: `${entityType}-1`,
        name: `Current ${entityType}`,
        slug: `current-${entityType}`,
      };
      const owner = store('store-2', 'Related Store', 'related-store');
      harness.findManyByUid[uid].mockResolvedValueOnce([source]);
      harness.findManyByUid['api::coupon.coupon']
        .mockResolvedValueOnce([{ categories: [category('cat-a')] }])
        .mockResolvedValueOnce([
          { stores: [owner], categories: [category('cat-a')] },
        ]);
      harness.findManyByUid['api::deal.deal']
        .mockResolvedValueOnce([{ categories: [category('cat-a')] }])
        .mockResolvedValueOnce([]);
      givenHydratedStores(harness, [hydratedStore(owner)]);

      const result = await harness.service.relatedStores(
        entityType,
        source.slug,
      );

      expect(
        harness.findManyByUid['api::coupon.coupon'].mock.calls[0]?.[0].filters,
      ).toMatchObject({
        [relationField]: { documentId: source.documentId },
      });
      expect(
        harness.findManyByUid['api::deal.deal'].mock.calls[0]?.[0].filters,
      ).toMatchObject({
        [relationField]: { documentId: source.documentId },
      });
      expect(result).toEqual({
        stores: [expect.objectContaining({ slug: 'related-store' })],
      });
    },
  );

  it('uses the selected Category directly and returns Stores attached to its active offers', async () => {
    const harness = createHarness();
    const selectedCategory = category('cat-a', 'mobiles');
    const owner = store('store-2', 'Mobile Store', 'mobile-store');
    harness.findManyByUid['api::category.category'].mockResolvedValueOnce([
      selectedCategory,
    ]);
    givenRelatedOffers(harness, [
      { stores: [owner], categories: [selectedCategory] },
    ]);
    givenHydratedStores(harness, [hydratedStore(owner)]);

    const result = await harness.service.relatedStores(
      'category',
      'mobiles',
    );

    expect(harness.findManyByUid['api::coupon.coupon']).toHaveBeenCalledTimes(1);
    expect(harness.findManyByUid['api::deal.deal']).toHaveBeenCalledTimes(1);
    expect(
      harness.findManyByUid['api::coupon.coupon'].mock.calls[0]?.[0].filters,
    ).toMatchObject({
      categories: { documentId: { $in: ['cat-a'] } },
    });
    expect(result).toEqual({
      stores: [expect.objectContaining({ slug: 'mobile-store' })],
    });
  });

  it('ranks Coupon owners without classifying Coupons by the presence of a code', async () => {
    const harness = createHarness();
    const owner = store('store-2', 'Coupon Store', 'coupon-store');
    givenCurrentStore(harness);
    givenRelatedOffers(harness, [
      {
        code: 'SAVE20',
        stores: [owner],
        categories: [category('cat-a')],
      },
      {
        code: null,
        stores: [owner],
        categories: [category('cat-a')],
      },
    ]);
    givenHydratedStores(harness, [hydratedStore(owner)]);

    const result = await harness.service.relatedStores('store', 'current-store', {
      categoryDocumentIds: 'cat-a',
    });

    expect(result.stores).toEqual([
      expect.objectContaining({
        documentId: 'store-2',
        offerCount: 2,
        sharedCategoryCount: 1,
      }),
    ]);
  });

  it('deduplicates the same owner listed twice inside one Deal', async () => {
    const harness = createHarness();
    const storesOwner = store('store-2', 'Stores Owner', 'stores-owner');
    const primaryOwner = store('store-3', 'Primary Owner', 'primary-owner');
    givenCurrentStore(harness);
    givenRelatedOffers(harness, [], [
      {
        stores: [storesOwner, primaryOwner, primaryOwner],
        categories: [category('cat-a')],
      },
    ]);
    givenHydratedStores(harness, [
      hydratedStore(primaryOwner),
      hydratedStore(storesOwner),
    ]);

    const result = await harness.service.relatedStores('store', 'current-store', {
      categorySlugs: 'cat-a',
    });

    expect(result.stores).toEqual([
      expect.objectContaining({ slug: 'primary-owner', offerCount: 1 }),
      expect.objectContaining({ slug: 'stores-owner', offerCount: 1 }),
    ]);
  });

  it('preserves category, offer, name, and stable-key ranking after unordered hydration', async () => {
    const harness = createHarness();
    const alpha = store('store-2', 'Alpha', 'alpha');
    const bravo = store('store-3', 'Bravo', 'bravo');
    const charlie = store('store-4', 'Charlie', 'charlie');
    const delta = store('store-5', 'Delta', 'delta');
    const echoOne = store('store-6', 'Echo', 'echo-one');
    const echoTwo = store('store-7', 'Echo', 'echo-two');
    givenCurrentStore(harness);
    givenRelatedOffers(harness, [
      { stores: [alpha], categories: [category('cat-a'), category('cat-b')] },
      { stores: [alpha], categories: [category('cat-a')] },
      { stores: [bravo], categories: [category('cat-a')] },
      { stores: [bravo], categories: [category('cat-a')] },
      { stores: [bravo], categories: [category('cat-a')] },
      { stores: [charlie], categories: [category('cat-a')] },
      { stores: [charlie], categories: [category('cat-a')] },
      { stores: [delta], categories: [category('cat-a')] },
      { stores: [delta], categories: [category('cat-a')] },
      { stores: [echoOne], categories: [category('cat-a')] },
      { stores: [echoTwo], categories: [category('cat-a')] },
    ]);
    givenHydratedStores(harness, [
      hydratedStore(delta),
      hydratedStore(bravo),
      hydratedStore(alpha),
      hydratedStore(charlie),
      hydratedStore(echoTwo),
      hydratedStore(echoOne),
    ]);

    const result = await harness.service.relatedStores('store', 'current-store', {
      categoryDocumentIds: 'cat-a,cat-b',
    });

    expect(result.stores.map((item: any) => item.slug)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo-one',
      'echo-two',
    ]);
    expect(result.stores.map((item: any) => item.offerCount)).toEqual([
      2, 3, 2, 2, 1, 1,
    ]);
  });

  it('clamps the result limit and hydrates a bounded pool before filtering artwork', async () => {
    const harness = createHarness();
    const candidates = Array.from({ length: 14 }, (_, index) =>
      store(`store-${index + 2}`, `Store ${String(index).padStart(2, '0')}`),
    );
    givenCurrentStore(harness);
    givenRelatedOffers(
      harness,
      candidates.map((owner) => ({
        stores: [owner],
        categories: [category('cat-a')],
      })),
    );
    givenHydratedStores(harness, candidates.slice(0, 12).map(hydratedStore));

    const result = await harness.service.relatedStores('store', 'current-store', {
      categorySlugs: 'cat-a',
      limit: '999',
    });

    expect(result.stores).toHaveLength(12);
    const hydrationQuery =
      harness.findManyByUid['api::store.store'].mock.calls[1]?.[0];
    expect(hydrationQuery.limit).toBe(14);
    expect(hydrationQuery.filters.$or[0].documentId.$in).toHaveLength(14);
    expect(hydrationQuery.filters.$or[1].slug.$in).toHaveLength(14);
  });

  it('uses the default limit for invalid input and caps category filters at twelve unique valid values', async () => {
    const harness = createHarness();
    const owners = Array.from({ length: 8 }, (_, index) =>
      store(`store-${index + 2}`, `Owner ${index}`, `owner-${index}`),
    );
    const suppliedCategories = [
      'cat-0',
      'cat-0',
      ...Array.from({ length: 15 }, (_, index) => `cat-${index + 1}`),
      'x'.repeat(161),
    ];
    givenCurrentStore(harness);
    givenRelatedOffers(
      harness,
      owners.map((owner) => ({
        stores: [owner],
        categories: [category('cat-0')],
      })),
    );
    givenHydratedStores(harness, owners.slice(0, 6).map(hydratedStore));

    await harness.service.relatedStores('store', 'current-store', {
      categoryDocumentIds: suppliedCategories,
      limit: 'not-a-number',
    });

    const relatedQuery =
      harness.findManyByUid['api::coupon.coupon'].mock.calls[0]?.[0];
    expect(relatedQuery.filters.categories.documentId.$in).toEqual(
      Array.from({ length: 12 }, (_, index) => `cat-${index}`),
    );
    expect(
      harness.findManyByUid['api::store.store'].mock.calls[1]?.[0].limit,
    ).toBe(8);
  });

  it('hydrates logos once after ranking and omits selected stores that no longer exist', async () => {
    const harness = createHarness();
    const first = store('store-2', 'First', 'first');
    const missing = store('store-3', 'Missing', 'missing');
    givenCurrentStore(harness);
    givenRelatedOffers(harness, [
      { stores: [first], categories: [category('cat-a')] },
      { stores: [missing], categories: [category('cat-a')] },
    ]);
    const hydratedFirst = hydratedStore(first);
    givenHydratedStores(harness, [hydratedFirst]);

    const result = await harness.service.relatedStores('store', 'current-store', {
      categorySlugs: 'cat-a',
    });

    expect(result.stores).toEqual([
      expect.objectContaining({
        slug: 'first',
        logo: hydratedFirst.logo,
        logoAlt: 'First logo',
      }),
    ]);
    expect(
      harness.findManyByUid['api::coupon.coupon'].mock.calls[0]?.[0].populate
        .stores,
    ).toEqual({ fields: ['name', 'slug'] });
    expect(
      harness.findManyByUid['api::deal.deal'].mock.calls[0]?.[0].populate,
    ).toEqual({
      stores: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
    });
    expect(
      harness.findManyByUid['api::store.store'].mock.calls[1]?.[0],
    ).toMatchObject({
      fields: ['name', 'slug', 'logoAlt'],
      populate: { logo: true },
      limit: 2,
    });
  });

  it('excludes the current store from mixed Coupon and Deal ownership', async () => {
    const harness = createHarness();
    const related = store('store-2', 'Related', 'related');
    givenCurrentStore(harness);
    givenRelatedOffers(
      harness,
      [
        {
          stores: [currentStore, related],
          categories: [category('cat-a')],
        },
      ],
      [
        {
          stores: [currentStore, related],
          categories: [category('cat-a')],
        },
      ],
    );
    givenHydratedStores(harness, [hydratedStore(related)]);

    const result = await harness.service.relatedStores('store', 'current-store', {
      categorySlugs: 'cat-a',
    });

    expect(result.stores).toEqual([
      expect.objectContaining({ slug: 'related', offerCount: 2 }),
    ]);
  });
});
