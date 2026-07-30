import { describe, expect, it, vi } from 'vitest';
import {
  curatedOfferTargetForRelationPath,
  normalizeCuratedRelationSearch,
  registerCuratedOfferRelationQueryFilter,
  removeDisplayedTopPicksFromOrdered,
  removeInactiveCuratedOfferRelations,
  runWithCuratedOfferRelationFilter,
} from './curated-offer-relations';

describe('curated offer relation picker filtering', () => {
  it('normalizes literal percent signs mixed with encoded spaces', () => {
    expect(normalizeCuratedRelationSearch('100%%20Whey%20Protein')).toBe(
      '100% Whey Protein',
    );
    expect(normalizeCuratedRelationSearch('  Whey Protein  ')).toBe(
      'Whey Protein',
    );
    expect(normalizeCuratedRelationSearch(['Whey'])).toEqual(['Whey']);
  });

  it('recognises available and existing nested component relation routes', () => {
    expect(
      curatedOfferTargetForRelationPath(
        '/content-manager/relations/home.deal-list/deals',
      ),
    ).toBe('api::deal.deal');
    expect(
      curatedOfferTargetForRelationPath(
        '/content-manager/relations/home.explore-offer-tab/42/offers',
      ),
    ).toBe('api::coupon.coupon');
    expect(
      curatedOfferTargetForRelationPath(
        '/content-manager/relations/home.hero-product%2Fwrong/deal',
      ),
    ).toBeNull();
    expect(
      curatedOfferTargetForRelationPath(
        '/content-manager/relations/home.popular-stores/stores',
      ),
    ).toBeNull();
    expect(
      curatedOfferTargetForRelationPath(
        '/content-manager/relations/api%3A%3Astore.store/store-1/topPickCoupons',
      ),
    ).toBe('api::coupon.coupon');
    expect(
      curatedOfferTargetForRelationPath(
        '/content-manager/relations/api%3A%3Acategory.category/category-1/orderedCoupons',
      ),
    ).toBe('api::coupon.coupon');
  });

  it('adds the same live constraint to relation result and pagination queries', () => {
    let subscriber: any;
    const strapi = {
      db: {
        lifecycles: {
          subscribe: vi.fn((value) => {
            subscriber = value;
          }),
        },
      },
    } as any;
    registerCuratedOfferRelationQueryFilter(strapi);

    const now = Date.now();
    const findEvent = {
      model: { uid: 'api::deal.deal' },
      params: { where: { title: { $containsi: 'phone' } } },
    };
    const countEvent = {
      model: { uid: 'api::deal.deal' },
      params: {},
    };

    runWithCuratedOfferRelationFilter('api::deal.deal', () => {
      subscriber.beforeFindMany(findEvent);
      subscriber.beforeCount(countEvent);
    });

    expect(findEvent.params.where.$and[0]).toEqual({
      title: { $containsi: 'phone' },
    });
    expect(findEvent.params.where.$and[1].contentStatus).toEqual({
      $eq: 'published',
    });
    expect(countEvent.params.where.contentStatus).toEqual({ $eq: 'published' });
    const cutoff = new Date(
      countEvent.params.where.$and[0].$or[1].expiresAt.$gt,
    ).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(now);

    const unrelated = {
      model: { uid: 'api::coupon.coupon' },
      params: { where: { code: 'SAVE' } },
    };
    runWithCuratedOfferRelationFilter('api::deal.deal', () => {
      subscriber.beforeFindMany(unrelated);
    });
    expect(unrelated.params.where).toEqual({ code: 'SAVE' });

    const missingParamsEvent: any = {
      model: { uid: 'api::deal.deal' },
    };
    runWithCuratedOfferRelationFilter('api::deal.deal', () => {
      subscriber.beforeFindMany(missingParamsEvent);
    });
    expect(missingParamsEvent.params.where.contentStatus).toEqual({
      $eq: 'published',
    });
  });
});

describe('curated offer relation cleanup', () => {
  it('disconnects scheduled, expired, and past-expiry offers while preserving live order', async () => {
    const now = new Date('2026-07-25T12:00:00.000Z');
    const update = vi.fn(async () => undefined);
    const findMany = vi.fn(async () => [
      {
        id: 7,
        deals: [
          { id: 1, contentStatus: 'published', expiresAt: null },
          {
            id: 2,
            contentStatus: 'published',
            expiresAt: '2026-07-25T11:59:59.000Z',
          },
          { id: 3, contentStatus: 'scheduled', expiresAt: null },
          { id: 4, contentStatus: 'expired', expiresAt: null },
          {
            id: 5,
            contentStatus: 'published',
            expiresAt: '2026-07-25T12:00:01.000Z',
          },
        ],
      },
    ]);
    const emptyFindMany = vi.fn(async () => []);
    const strapi = {
      db: {
        query: vi.fn((uid: string) =>
          uid === 'home.deal-list'
            ? { findMany, update }
            : { findMany: emptyFindMany, update: vi.fn() },
        ),
      },
    } as any;

    await expect(
      removeInactiveCuratedOfferRelations(strapi, now),
    ).resolves.toEqual({
      removedSelections: 3,
      affectedPaths: ['/'],
      requiresFullRevalidation: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { deals: { disconnect: [2, 3, 4] } },
    });
  });

  it('handles to-one component relations with the same disconnect command', async () => {
    const update = vi.fn(async () => undefined);
    const strapi = {
      db: {
        query: vi.fn((uid: string) => ({
          findMany: vi.fn(async () =>
            uid === 'home.hero-product'
              ? [{ id: 9, deal: { id: 88, contentStatus: 'expired' } }]
              : [],
          ),
          update,
        })),
      },
    } as any;

    await expect(
      removeInactiveCuratedOfferRelations(
        strapi,
        new Date('2026-07-25T12:00:00.000Z'),
      ),
    ).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: ['/'],
      requiresFullRevalidation: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { deal: { disconnect: [88] } },
    });
  });

  it('disconnects expired entity Top Pick Coupons without touching taxonomy relations', async () => {
    const update = vi.fn(async () => undefined);
    const strapi = {
      db: {
        query: vi.fn((uid: string) => ({
          findMany: vi.fn(async () =>
          uid === 'api::store.store'
              ? [
                  {
                    id: 12,
                    slug: 'store/amazon',
                    topPickCoupons: [
                      { id: 21, contentStatus: 'published' },
                      { id: 22, contentStatus: 'expired' },
                    ],
                  },
                ]
              : [],
          ),
          update,
        })),
      },
    } as any;

    await expect(
      removeInactiveCuratedOfferRelations(
        strapi,
        new Date('2026-07-25T12:00:00.000Z'),
      ),
    ).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: ['/amazon/'],
      requiresFullRevalidation: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { topPickCoupons: { disconnect: [22] } },
    });
    expect(JSON.stringify(update.mock.calls)).not.toContain('stores');
  });

  it('disconnects expired Ordered Coupons and reports the entity route for ISR', async () => {
    const update = vi.fn(async () => undefined);
    const strapi = {
      db: {
        query: vi.fn((uid: string) => ({
          findMany: vi.fn(async (query: any) =>
            uid === 'api::brand.brand' &&
            query.populate?.orderedCoupons
              ? [
                  {
                    id: 14,
                    slug: 'nike-coupons',
                    orderedCoupons: [
                      { id: 31, contentStatus: 'published' },
                      { id: 32, contentStatus: 'expired' },
                    ],
                  },
                ]
              : [],
          ),
          update,
        })),
      },
    } as any;

    await expect(
      removeInactiveCuratedOfferRelations(
        strapi,
        new Date('2026-07-25T12:00:00.000Z'),
      ),
    ).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: ['/nike-coupons/'],
      requiresFullRevalidation: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 14 },
      data: { orderedCoupons: { disconnect: [32] } },
    });
  });

  it('falls back to full revalidation when an affected entity has no route slug', async () => {
    const strapi = {
      db: {
        query: vi.fn((uid: string) => ({
          findMany: vi.fn(async () =>
            uid === 'api::bank.bank'
              ? [
                  {
                    id: 31,
                    slug: null,
                    topPickCoupons: [
                      { id: 41, contentStatus: 'expired' },
                    ],
                  },
                ]
              : [],
          ),
          update: vi.fn(async () => undefined),
        })),
      },
    } as any;

    await expect(
      removeInactiveCuratedOfferRelations(strapi),
    ).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: [],
      requiresFullRevalidation: true,
    });
  });
});

describe('displayed Top Picks are kept out of Ordered Coupons', () => {
  function harness(row: unknown, uid = 'api::store.store') {
    const update = vi.fn(async () => undefined);
    const strapi = {
      db: {
        query: vi.fn((queriedUid: string) => ({
          findMany: vi.fn(async () => (queriedUid === uid && row ? [row] : [])),
          update,
        })),
      },
      log: { info: vi.fn() },
    } as any;
    return { strapi, update };
  }

  it('disconnects a displayed Top Pick from Ordered Coupons', async () => {
    const { strapi, update } = harness({
      id: 7,
      slug: 'amazon-coupons',
      // Index 0 and 1 are the displayed picks. Query Engine populate preserves
      // link-table order, so position here is the rendered position.
      topPickCoupons: [
        { id: 21, documentId: 'coupon-21' },
        { id: 22, documentId: 'coupon-22' },
      ],
      orderedCoupons: [
        { id: 22, documentId: 'coupon-22' },
        { id: 30, documentId: 'coupon-30' },
      ],
    });

    await expect(removeDisplayedTopPicksFromOrdered(strapi)).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: ['/amazon-coupons/'],
      requiresFullRevalidation: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { orderedCoupons: { disconnect: [22] } },
    });
    expect(strapi.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'content.displayed_top_pick_removed_from_ordered',
        coupons: ['coupon-22'],
      }),
    );
  });

  it('leaves an expiry buffer alone', async () => {
    // Positions 3-4 never render, so ordering them in the main list is exactly
    // what they are for.
    const { strapi, update } = harness({
      id: 8,
      slug: 'nike-coupons',
      topPickCoupons: [
        { id: 21, documentId: 'coupon-21' },
        { id: 22, documentId: 'coupon-22' },
        { id: 23, documentId: 'coupon-23' },
        { id: 24, documentId: 'coupon-24' },
      ],
      orderedCoupons: [
        { id: 23, documentId: 'coupon-23' },
        { id: 24, documentId: 'coupon-24' },
      ],
    });

    await expect(removeDisplayedTopPicksFromOrdered(strapi)).resolves.toEqual({
      removedSelections: 0,
      affectedPaths: [],
      requiresFullRevalidation: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('removes a buffer only once it has been promoted into a shown slot', async () => {
    // What the expiry pass leaves behind: the two displayed picks are gone,
    // so the buffer that is also ordered is now rendered and must leave the
    // main list.
    const { strapi, update } = harness({
      id: 9,
      slug: 'hdfc-offers',
      topPickCoupons: [
        { id: 23, documentId: 'coupon-23' },
        { id: 24, documentId: 'coupon-24' },
      ],
      orderedCoupons: [
        { id: 23, documentId: 'coupon-23' },
        { id: 40, documentId: 'coupon-40' },
      ],
    });

    await expect(removeDisplayedTopPicksFromOrdered(strapi)).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: ['/hdfc-offers/'],
      requiresFullRevalidation: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { orderedCoupons: { disconnect: [23] } },
    });
  });

  it('does nothing when either relation is empty', async () => {
    const { strapi, update } = harness({
      id: 10,
      slug: 'puma-coupons',
      topPickCoupons: [{ id: 21, documentId: 'coupon-21' }],
      orderedCoupons: [],
    });

    await expect(removeDisplayedTopPicksFromOrdered(strapi)).resolves.toEqual({
      removedSelections: 0,
      affectedPaths: [],
      requiresFullRevalidation: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back to full revalidation when the entity has no route slug', async () => {
    const { strapi } = harness(
      {
        id: 11,
        slug: null,
        topPickCoupons: [{ id: 21, documentId: 'coupon-21' }],
        orderedCoupons: [{ id: 21, documentId: 'coupon-21' }],
      },
      'api::bank.bank',
    );

    await expect(removeDisplayedTopPicksFromOrdered(strapi)).resolves.toEqual({
      removedSelections: 1,
      affectedPaths: [],
      requiresFullRevalidation: true,
    });
  });
});
