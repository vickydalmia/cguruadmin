import { describe, expect, it, vi } from 'vitest';
import {
  curatedOfferTargetForRelationPath,
  registerCuratedOfferRelationQueryFilter,
  removeInactiveCuratedOfferRelations,
  runWithCuratedOfferRelationFilter,
} from './curated-offer-relations';

describe('curated offer relation picker filtering', () => {
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
