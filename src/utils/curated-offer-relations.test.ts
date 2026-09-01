import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getCuratedOfferRelations } from './curated-offer-relations';
import { removeInactiveCuratedOfferRelations } from './curated-offer-cleanup';
import {
  curatedOfferTargetForRelationPath,
  isContentManagerRelationPath,
  normalizeRelationSearch,
  registerCuratedOfferRelationQueryFilter,
  runWithCuratedOfferRelationFilter,
} from './curated-offer-live-filter';
import { removeDisplayedTopPicksFromOrdered } from './curated-offer-top-picks';

/**
 * A `strapi` shaped like the loaded registries, built from the real schema
 * files, so the derived curated list in these tests is the one production
 * derives.
 */
function schemaStrapi(extra: Record<string, unknown> = {}): any {
  const components: Record<string, any> = {};
  const componentsDir = path.join(process.cwd(), 'src', 'components');
  for (const namespace of readdirSync(componentsDir)) {
    const dir = path.join(componentsDir, namespace);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      components[`${namespace}.${file.slice(0, -'.json'.length)}`] = JSON.parse(
        readFileSync(path.join(dir, file), 'utf8'),
      );
    }
  }

  const contentTypes: Record<string, any> = {};
  const apiDir = path.join(process.cwd(), 'src', 'api');
  for (const api of readdirSync(apiDir)) {
    const typesDir = path.join(apiDir, api, 'content-types');
    let names: string[] = [];
    try {
      names = readdirSync(typesDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const schemaPath = path.join(typesDir, name, 'schema.json');
      try {
        contentTypes[`api::${api}.${name}`] = JSON.parse(
          readFileSync(schemaPath, 'utf8'),
        );
      } catch {
        // content-type folder without a schema
      }
    }
  }

  return { components, contentTypes, ...extra };
}

const relationKey = (relation: { sourceUid: string; field: string }) =>
  `${relation.sourceUid}.${relation.field}`;

describe('curated offer relation derivation', () => {
  // The drift alarm: every component relation targeting Coupon/Deal plus every
  // unidirectional content-type relation targeting them must be curated —
  // nothing more, nothing less.
  it('derives exactly the known curated set from the schemas', () => {
    const derived = [...getCuratedOfferRelations(schemaStrapi())].sort((a, b) =>
      relationKey(a).localeCompare(relationKey(b)),
    );

    expect(derived).toEqual(
      [
        { sourceUid: 'home.hero-product', field: 'deal', targetUid: 'api::deal.deal' },
        { sourceUid: 'home.hero-product', field: 'coupon', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'home.top-offer-item', field: 'coupon', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'home.exclusive-item', field: 'coupon', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'home.coupon-card-item', field: 'coupon', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'home.offer-list', field: 'offers', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'home.explore-offer-tab', field: 'offers', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'home.deal-list', field: 'deals', targetUid: 'api::deal.deal' },
        { sourceUid: 'home.explore-tab', field: 'deals', targetUid: 'api::deal.deal' },
        { sourceUid: 'deal-day.section-heading', field: 'deals', targetUid: 'api::deal.deal' },
        { sourceUid: 'deal-day.store-tab', field: 'deals', targetUid: 'api::deal.deal' },
        { sourceUid: 'deal-day.telegram-deal-item', field: 'deal', targetUid: 'api::deal.deal' },
        { sourceUid: 'festival.coupon-category-tab', field: 'offers', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'festival.coupon-store-tab', field: 'offers', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'header.coupon-notification', field: 'coupon', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'header.product-deal-notification', field: 'productDeal', targetUid: 'api::deal.deal' },
        { sourceUid: 'api::store.store', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::store.store', field: 'orderedCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::brand.brand', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::brand.brand', field: 'orderedCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::category.category', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::category.category', field: 'orderedCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::bank.bank', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
        { sourceUid: 'api::bank.bank', field: 'orderedCoupons', targetUid: 'api::coupon.coupon' },
      ].sort((a, b) => relationKey(a).localeCompare(relationKey(b))),
    );
  });
});

describe('curated offer relation picker filtering', () => {
  it('normalizes literal percent signs mixed with encoded spaces', () => {
    expect(normalizeRelationSearch('100%%20Whey%20Protein')).toBe(
      '100% Whey Protein',
    );
    expect(normalizeRelationSearch('  Whey Protein  ')).toBe(
      'Whey Protein',
    );
    expect(normalizeRelationSearch(['Whey'])).toEqual(['Whey']);
  });

  it('detects Content Manager relation paths regardless of curation', () => {
    expect(
      isContentManagerRelationPath(
        '/content-manager/relations/home.popular-stores/stores',
      ),
    ).toBe(true);
    expect(
      isContentManagerRelationPath('/content-manager/relations/home.deal-list'),
    ).toBe(false);
    expect(isContentManagerRelationPath('/api/coupons')).toBe(false);
  });

  it('recognises available and existing nested component relation routes', () => {
    const strapi = schemaStrapi();
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/home.deal-list/deals',
      ),
    ).toBe('api::deal.deal');
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/header.coupon-notification/12/coupon',
      ),
    ).toBe('api::coupon.coupon');
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/header.product-deal-notification/productDeal',
      ),
    ).toBe('api::deal.deal');
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/home.explore-offer-tab/42/offers',
      ),
    ).toBe('api::coupon.coupon');
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/home.hero-product%2Fwrong/deal',
      ),
    ).toBeNull();
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/home.popular-stores/stores',
      ),
    ).toBeNull();
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
        '/content-manager/relations/api%3A%3Astore.store/store-1/topPickCoupons',
      ),
    ).toBe('api::coupon.coupon');
    expect(
      curatedOfferTargetForRelationPath(
        strapi,
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
    const strapi = schemaStrapi({
      db: {
        query: vi.fn((uid: string) =>
          uid === 'home.deal-list'
            ? { findMany, update }
            : { findMany: emptyFindMany, update: vi.fn() },
        ),
      },
    });

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
    const strapi = schemaStrapi({
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
    });

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
    const strapi = schemaStrapi({
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
    });

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
    const strapi = schemaStrapi({
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
    });

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
    const strapi = schemaStrapi({
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
    });

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
    const strapi = schemaStrapi({
      db: {
        query: vi.fn((queriedUid: string) => ({
          findMany: vi.fn(async () => (queriedUid === uid && row ? [row] : [])),
          update,
        })),
      },
      log: { info: vi.fn() },
    });
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
