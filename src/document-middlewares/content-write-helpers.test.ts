import { describe, expect, it, vi } from 'vitest';

import { EMPTY_ENTITY_OFFER_SNAPSHOT } from '../utils/affiliate-brand-validation';
import { buildWriteInvalidation } from './build-write-invalidation';
import { captureWriteSnapshot } from './capture-write-snapshot';
import type { WriteSnapshot } from './content-write-types';

// Only offerRelationScope is faked (it reads ~5 tables per offer); everything
// else in the scopes module runs for real so these stay characterization
// tests of the builder's own logic.
vi.mock('../isr-outbox/scopes', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../isr-outbox/scopes')>();
  return {
    ...original,
    offerRelationScope: vi.fn(
      async (_strapi: unknown, _uid: string, documentId: string) => ({
        slugs: [`/${documentId}/`],
        optionalSlugs: [],
      }),
    ),
  };
});

const EMPTY_SNAPSHOT: WriteSnapshot = {
  redirectBefore: null,
  offerWasPublished: false,
  preScope: null,
  entityIdentityBefore: null,
  festiveOfferBefore: null,
  entityOfferSweep: false,
  entityOffersBefore: EMPTY_ENTITY_OFFER_SNAPSHOT,
  merchantReferencedOffers: [],
  brandAffiliateBefore: null,
};

describe('captureWriteSnapshot fallbacks', () => {
  it('fails safe when every qualifying Brand pre-read rejects', async () => {
    const findOne = vi.fn(async () => {
      throw new Error('db unavailable');
    });
    const strapi = {
      documents: vi.fn(() => ({ findOne })),
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;

    const snapshot = await captureWriteSnapshot(strapi, {
      uid: 'api::brand.brand',
      action: 'update',
      params: { documentId: 'brand-1', data: { coupons: [] } },
    });

    expect(snapshot).toEqual({
      redirectBefore: null,
      offerWasPublished: false,
      preScope: null,
      entityIdentityBefore: null,
      festiveOfferBefore: null,
      entityOfferSweep: true,
      entityOffersBefore: null,
      merchantReferencedOffers: [],
      brandAffiliateBefore: null,
    });
  });

  it('uses empty offer membership for a new entity without relation writes', async () => {
    const documents = vi.fn();
    const snapshot = await captureWriteSnapshot(
      { documents } as any,
      {
        uid: 'api::brand.brand',
        action: 'create',
        params: { data: {} },
      },
    );

    expect(snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(documents).not.toHaveBeenCalled();
  });
});

describe('buildWriteInvalidation characterization', () => {
  it('suppresses a redirect note-only update after maintenance cleanup', async () => {
    const removeInactiveCuratedOffer = vi.fn(async () => undefined);
    const strapi = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;
    const result = await buildWriteInvalidation(
      strapi,
      {
        uid: 'api::redirect.redirect',
        action: 'update',
        params: { documentId: 'redirect-1', data: { note: 'editor note' } },
      },
      {
        ...EMPTY_SNAPSHOT,
        redirectBefore: {
          from: '/old',
          to: '/new',
          statusCode: 301,
          active: true,
        },
        preScope: { full: true },
      },
      {
        documentId: 'redirect-1',
        affiliateCascade: null,
        removeInactiveCuratedOffer,
      },
    );

    expect(result).toBeNull();
    expect(removeInactiveCuratedOffer).toHaveBeenCalledOnce();
  });
});

describe('captureWriteSnapshot — store/brand delete', () => {
  it('pre-reads member offers AND checkoutMerchant references', async () => {
    const findOne = vi.fn(async () => ({
      coupons: [{ documentId: 'offer-1' }],
      deals: [],
    }));
    const findMany = vi.fn(async ({ where }: any) =>
      where?.checkoutMerchant === 'store:store-1'
        ? [{ documentId: 'offer-2' }]
        : [],
    );
    const strapi = {
      documents: vi.fn(() => ({ findOne })),
      db: { query: vi.fn(() => ({ findMany })) },
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;

    const snapshot = await captureWriteSnapshot(strapi, {
      uid: 'api::store.store',
      action: 'delete',
      params: { documentId: 'store-1' },
    });

    expect(snapshot.entityOfferSweep).toBe(true);
    expect(snapshot.entityOffersBefore).toEqual({
      'api::coupon.coupon': new Set(['offer-1']),
      'api::deal.deal': new Set(),
    });
    // Both offer tables are asked for merchant references, coupons and deals.
    expect(snapshot.merchantReferencedOffers).toEqual([
      { uid: 'api::coupon.coupon', documentId: 'offer-2' },
      { uid: 'api::deal.deal', documentId: 'offer-2' },
    ]);
  });

  it('poisons the baseline to null when a merchant-reference read fails', async () => {
    const findOne = vi.fn(async () => ({ coupons: [], deals: [] }));
    const findMany = vi.fn(async () => {
      throw new Error('db unavailable');
    });
    const strapi = {
      documents: vi.fn(() => ({ findOne })),
      db: { query: vi.fn(() => ({ findMany })) },
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;

    const snapshot = await captureWriteSnapshot(strapi, {
      uid: 'api::brand.brand',
      action: 'delete',
      params: { documentId: 'brand-1' },
    });

    // Unknown reference set → the invalidation builder must fail toward the
    // full sweep, which it keys off the null baseline.
    expect(snapshot.entityOfferSweep).toBe(true);
    expect(snapshot.entityOffersBefore).toBeNull();
  });
});

describe('buildWriteInvalidation — store/brand delete sweep', () => {
  const logOnlyStrapi = () =>
    ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }) as any;
  const maintenanceFor = (documentId: string) => ({
    documentId,
    affiliateCascade: null,
    removeInactiveCuratedOffer: vi.fn(async () => undefined),
  });

  it('invalidates every pre-delete member offer and merchant reference', async () => {
    const result = await buildWriteInvalidation(
      logOnlyStrapi(),
      {
        uid: 'api::store.store',
        action: 'delete',
        params: { documentId: 'store-1' },
      },
      {
        ...EMPTY_SNAPSHOT,
        preScope: { slugs: ['/amazon-coupons/'] },
        entityOfferSweep: true,
        entityOffersBefore: {
          'api::coupon.coupon': new Set(['offer-1']),
          'api::deal.deal': new Set(),
        },
        merchantReferencedOffers: [
          { uid: 'api::coupon.coupon', documentId: 'offer-2' },
        ],
      },
      maintenanceFor('store-1'),
    );

    expect(result).not.toBeNull();
    const payload: any = result!.payload;
    expect(payload.all).toBeUndefined();
    expect(payload.paths).toEqual(
      expect.arrayContaining(['/amazon-coupons/', '/offer-1/', '/offer-2/']),
    );
    expect(payload.offerInvalidations).toEqual([
      { entityType: 'coupon', documentId: 'offer-1' },
      { entityType: 'coupon', documentId: 'offer-2' },
    ]);
  });

  it('escalates to a full rebuild when the pre-delete baseline is unknown', async () => {
    const result = await buildWriteInvalidation(
      logOnlyStrapi(),
      {
        uid: 'api::store.store',
        action: 'delete',
        params: { documentId: 'store-1' },
      },
      {
        ...EMPTY_SNAPSHOT,
        preScope: { slugs: ['/amazon-coupons/'] },
        entityOfferSweep: true,
        entityOffersBefore: null as any,
      },
      maintenanceFor('store-1'),
    );

    expect((result!.payload as any).all).toBe(true);
  });

  it('escalates to a full rebuild past the rerouted-offer cap of 10', async () => {
    const memberDocIds = Array.from({ length: 11 }, (_, i) => `offer-${i}`);
    const result = await buildWriteInvalidation(
      logOnlyStrapi(),
      {
        uid: 'api::store.store',
        action: 'delete',
        params: { documentId: 'store-1' },
      },
      {
        ...EMPTY_SNAPSHOT,
        preScope: { slugs: ['/amazon-coupons/'] },
        entityOfferSweep: true,
        entityOffersBefore: {
          'api::coupon.coupon': new Set(memberDocIds),
          'api::deal.deal': new Set(),
        },
      },
      maintenanceFor('store-1'),
    );

    const payload: any = result!.payload;
    expect(payload.all).toBe(true);
    // Even on the full path, every offer still gets its targeted
    // offer-invalidation entry (the redeem/interstitial caches key on them).
    expect(payload.offerInvalidations).toHaveLength(11);
  });
});
