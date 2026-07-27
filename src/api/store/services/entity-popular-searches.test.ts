import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEntityPopularSearches,
  popularSearchLeaderboardsChanged,
  purgeEntityPopularSearchCatalog,
  readPopularSearchFallbackLeaderboards,
} from './entity-popular-searches';

const relation = (documentId: string, name = documentId, slug = documentId) => ({
  documentId,
  name,
  slug,
});

function harness(
  sourceUid: string,
  source: any,
  coupons: any[],
  deals: any[],
) {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  const values: Record<string, any[]> = {
    [sourceUid]: [source],
    'api::coupon.coupon': coupons,
    'api::deal.deal': deals,
  };
  const strapi = {
    documents: vi.fn((uid: string) => {
      calls[uid] ??= vi.fn().mockResolvedValue(values[uid] ?? []);
      return { findMany: calls[uid] };
    }),
  } as any;
  return { strapi, calls };
}

describe('entity Popular Searches aggregate', () => {
  beforeEach(() => {
    purgeEntityPopularSearchCatalog();
  });

  it.each([
    ['store', 'api::store.store', ['brand', 'category', 'bank']],
    ['brand', 'api::brand.brand', ['store', 'category', 'bank']],
    ['category', 'api::category.category', ['store', 'brand', 'bank']],
    ['bank', 'api::bank.bank', ['store', 'brand', 'category']],
  ] as const)('keeps fixed group order for a %s source', async (kind, uid, order) => {
    const source = relation(`${kind}-source`, 'Source', 'source');
    const { strapi } = harness(uid, source, [], []);
    const groups = await buildEntityPopularSearches(strapi, kind, 'source');
    expect(groups?.map((group) => group.kind)).toEqual(order);
  });

  it('counts distinct Coupons and Deals equally, deduplicates repeated relations, and uses stable ties', async () => {
    const source = relation('store-source', 'Source', 'source');
    const alpha = relation('brand-a', 'Alpha', 'alpha');
    const beta = relation('brand-b', 'Beta', 'beta');
    const { strapi } = harness(
      'api::store.store',
      source,
      [{
        documentId: 'coupon-1',
        stores: [source, source],
        brands: [beta, beta, alpha],
      }],
      [{
        documentId: 'deal-1',
        stores: [source],
        brands: [alpha],
      }],
    );

    const groups = await buildEntityPopularSearches(strapi, 'store', 'source');
    expect(groups?.find((group) => group.kind === 'brand')?.items).toEqual([
      alpha,
      beta,
    ]);
  });

  it('fills only short related groups from eligible global inventory without duplicates', async () => {
    const source = relation('store-source', 'Source', 'source');
    const related = relation('brand-related', 'Related', 'related');
    const globals = Array.from({ length: 6 }, (_, index) =>
      relation(`brand-${index}`, `Brand ${index}`, `brand-${index}`),
    );
    const { strapi } = harness(
      'api::store.store',
      source,
      [
        { documentId: 'coupon-related', stores: [source], brands: [related] },
        ...globals.map((brand, index) => ({
          documentId: `coupon-global-${index}`,
          stores: [],
          brands: [brand],
        })),
      ],
      [],
    );

    const brands = (await buildEntityPopularSearches(
      strapi,
      'store',
      'source',
    ))?.find((group) => group.kind === 'brand')?.items;
    expect(brands).toHaveLength(5);
    expect(brands?.[0]).toEqual(related);
    expect(new Set(brands?.map((item) => item.documentId)).size).toBe(5);
  });

  it('filters the dedicated Deal of the Day category from related and fallback results', async () => {
    const source = relation('store-source', 'Source', 'source');
    const special = relation(
      'category-dotd',
      'Deal of the Day',
      'categories/deal-of-the-day',
    );
    const regular = relation('category-regular', 'Electronics', 'electronics');
    const { strapi } = harness(
      'api::store.store',
      source,
      [
        {
          documentId: 'coupon-related',
          stores: [source],
          categories: [special, regular],
        },
      ],
      [],
    );
    const result = await buildEntityPopularSearches(strapi, 'store', 'source');
    expect(result?.find((group) => group.kind === 'category')?.items).toEqual([
      regular,
    ]);
  });

  it('caps groups at ten and does not append fallback to an already sufficient related group', async () => {
    const source = relation('store-source', 'Source', 'source');
    const brands = Array.from({ length: 12 }, (_, index) =>
      relation(`brand-${index}`, `Brand ${String(index).padStart(2, '0')}`, `brand-${index}`),
    );
    const { strapi } = harness(
      'api::store.store',
      source,
      brands.map((brand, index) => ({
        documentId: `coupon-${index}`,
        stores: [source],
        brands: [brand],
      })),
      [],
    );
    const result = await buildEntityPopularSearches(strapi, 'store', 'source');
    expect(result?.find((group) => group.kind === 'brand')?.items).toHaveLength(10);
  });

  it('queries only published, unexpired inventory and exposes identity fields', async () => {
    const source = relation('store-source', 'Source', 'source');
    const { strapi, calls } = harness('api::store.store', source, [], []);
    const groups = await buildEntityPopularSearches(strapi, 'store', 'source');
    const query = calls['api::coupon.coupon']?.mock.calls[0]?.[0];
    expect(query.filters).toMatchObject({
      contentStatus: { $eq: 'published' },
      $and: [
        { $or: [{ expiresAt: { $null: true } }, { expiresAt: { $gt: expect.any(String) } }] },
        { $or: [{ scheduledAt: { $null: true } }, { scheduledAt: { $lte: expect.any(String) } }] },
      ],
    });
    expect(query.populate.stores.fields).toEqual(['documentId', 'name', 'slug']);
    expect(groups).toEqual([
      { kind: 'brand', items: [] },
      { kind: 'category', items: [] },
      { kind: 'bank', items: [] },
    ]);
  });

  it('builds one shared catalog for different entity requests in the TTL window', async () => {
    const store = relation('store-source', 'Store', 'store');
    const brand = relation('brand-source', 'Brand', 'brand');
    const { strapi, calls } = harness(
      'api::store.store',
      store,
      [{ documentId: 'coupon-1', stores: [store], brands: [brand] }],
      [],
    );
    calls['api::brand.brand'] = vi.fn().mockResolvedValue([brand]);

    await buildEntityPopularSearches(strapi, 'store', 'store');
    await buildEntityPopularSearches(strapi, 'brand', 'brand');

    expect(calls['api::coupon.coupon']).toHaveBeenCalledTimes(1);
    expect(calls['api::deal.deal']).toHaveBeenCalledTimes(1);
  });

  it('purges the shared catalog and bypasses it for transaction-visible reads', async () => {
    const source = relation('store-source', 'Store', 'store');
    const { strapi, calls } = harness(
      'api::store.store',
      source,
      [{ documentId: 'coupon-1', stores: [source] }],
      [],
    );

    await buildEntityPopularSearches(strapi, 'store', 'store');
    await readPopularSearchFallbackLeaderboards(strapi, vi.fn());
    expect(calls['api::coupon.coupon']).toHaveBeenCalledTimes(2);

    purgeEntityPopularSearchCatalog();
    await buildEntityPopularSearches(strapi, 'store', 'store');
    expect(calls['api::coupon.coupon']).toHaveBeenCalledTimes(3);
  });

  it('compares only visible top-ten leaderboard order and accepts the active transaction marker', async () => {
    const { strapi } = harness('unused', null, [], []);
    const trx = vi.fn();
    const board = await readPopularSearchFallbackLeaderboards(strapi, trx);
    expect(popularSearchLeaderboardsChanged(board, board)).toBe(false);
    expect(popularSearchLeaderboardsChanged(board, {
      ...board,
      store: ['changed'],
    })).toBe(true);
    await expect(
      readPopularSearchFallbackLeaderboards(strapi, {}),
    ).rejects.toThrow(/active write transaction/u);
  });
});
