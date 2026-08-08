import { describe, expect, it, vi } from 'vitest';

import {
  detachAffiliateBrand,
  diffEntityOfferSnapshots,
  EMPTY_ENTITY_OFFER_SNAPSHOT,
  snapshotEntityOfferRelations,
  validateEntityOfferAffiliateConnections,
  validateOfferAffiliateBrands,
} from './affiliate-brand-validation';
import type { OfferStoreUid } from './content-manager-offer-store-validation';

const AFFILIATE = { id: 9, documentId: 'brand-aff', name: 'AffBrand' };
const OTHER_BRAND = { id: 5, documentId: 'brand-plain' };
const STORE = { id: 1, documentId: 'store-1' };

function harness({
  current = null as unknown,
  affiliateRows = [] as unknown[],
} = {}) {
  const findOne = vi.fn().mockResolvedValue(current);
  const brandFindMany = vi.fn().mockResolvedValue(affiliateRows);
  const strapi = {
    documents: vi.fn(() => ({ findOne })),
    db: { query: vi.fn(() => ({ findMany: brandFindMany })) },
  } as any;
  return { strapi, findOne, brandFindMany };
}

const errorPaths = (error: unknown) =>
  (
    error as { details?: { errors?: { path?: (string | number)[] }[] } }
  ).details?.errors?.map((entry) => entry.path);

const catchFrom = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe.each(['api::coupon.coupon', 'api::deal.deal'] as OfferStoreUid[])(
  'validateOfferAffiliateBrands — %s',
  (uid) => {
    it('ignores non-write actions', async () => {
      const { strapi, brandFindMany } = harness();
      await expect(
        validateOfferAffiliateBrands(strapi, uid, 'delete', { brands: [AFFILIATE] }),
      ).resolves.toBeUndefined();
      expect(brandFindMany).not.toHaveBeenCalled();
    });

    it('skips an untouched payload when not strict (status-cron partials)', async () => {
      const { strapi, findOne } = harness();
      await expect(
        validateOfferAffiliateBrands(
          strapi,
          uid,
          'update',
          { contentStatus: 'expired' },
          'offer-1',
          false,
        ),
      ).resolves.toBeUndefined();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('strict re-arms the check on the effective record', async () => {
      const { strapi } = harness({
        current: { stores: [STORE], brands: [AFFILIATE], checkoutMerchant: null },
        affiliateRows: [AFFILIATE],
      });
      const caught = await catchFrom(() =>
        validateOfferAffiliateBrands(
          strapi,
          uid,
          'update',
          { title: 'unrelated edit' },
          'offer-1',
          true,
        ),
      );
      expect((caught as Error).message).toContain('cannot be combined with a Store');
      expect(errorPaths(caught)).toEqual([['brands']]);
    });

    it('accepts an affiliate brand as the sole merchant', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      await expect(
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE],
        }),
      ).resolves.toBeUndefined();
    });

    it('accepts non-affiliate brands mixing with a store', async () => {
      const { strapi } = harness({ affiliateRows: [] });
      await expect(
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [OTHER_BRAND, { id: 6 }],
          stores: [STORE],
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects an affiliate brand sharing the offer with another brand', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      const caught = await catchFrom(() =>
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE, OTHER_BRAND],
        }),
      );
      expect((caught as Error).message).toContain('must be the ONLY brand');
      expect(errorPaths(caught)).toEqual([['brands']]);
    });

    it('rejects an affiliate brand alongside a store', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      const caught = await catchFrom(() =>
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE],
          stores: [STORE],
        }),
      );
      expect((caught as Error).message).toContain('cannot be combined with a Store');
    });

    it('rejects a checkout merchant pointing at a store', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      const caught = await catchFrom(() =>
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE],
          checkoutMerchant: 'store:store-1',
        }),
      );
      expect(errorPaths(caught)).toEqual([['checkoutMerchant']]);
      expect((caught as Error).message).toContain('cannot point at a Store');
    });

    it('rejects a checkout merchant pointing at a different brand', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      const caught = await catchFrom(() =>
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE],
          checkoutMerchant: 'brand:brand-plain',
        }),
      );
      expect(errorPaths(caught)).toEqual([['checkoutMerchant']]);
    });

    it('accepts a checkout merchant pointing at the affiliate brand itself', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      await expect(
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE],
          checkoutMerchant: 'brand:brand-aff',
        }),
      ).resolves.toBeUndefined();
    });

    it('reports every violation of one payload together', async () => {
      const { strapi } = harness({ affiliateRows: [AFFILIATE] });
      const caught = await catchFrom(() =>
        validateOfferAffiliateBrands(strapi, uid, 'create', {
          brands: [AFFILIATE, OTHER_BRAND],
          stores: [STORE],
          checkoutMerchant: 'store:store-1',
        }),
      );
      expect(errorPaths(caught)).toEqual([
        ['brands'],
        ['brands'],
        ['checkoutMerchant'],
      ]);
    });
  },
);

describe('validateOfferAffiliateBrands — relation payload shapes', () => {
  const uid: OfferStoreUid = 'api::coupon.coupon';

  it('resolves connect deltas against the stored brands', async () => {
    const { strapi } = harness({
      current: { stores: [], brands: [OTHER_BRAND], checkoutMerchant: null },
      affiliateRows: [AFFILIATE],
    });
    const caught = await catchFrom(() =>
      validateOfferAffiliateBrands(
        strapi,
        uid,
        'update',
        { brands: { connect: [AFFILIATE] } },
        'offer-1',
      ),
    );
    expect((caught as Error).message).toContain('must be the ONLY brand');
  });

  it('passes when the same delta also disconnects the conflicting brand', async () => {
    const { strapi } = harness({
      current: { stores: [], brands: [OTHER_BRAND], checkoutMerchant: null },
      affiliateRows: [AFFILIATE],
    });
    await expect(
      validateOfferAffiliateBrands(
        strapi,
        uid,
        'update',
        { brands: { connect: [AFFILIATE], disconnect: [OTHER_BRAND] } },
        'offer-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves untouched stores from the stored row', async () => {
    const { strapi } = harness({
      current: { stores: [STORE], brands: [], checkoutMerchant: null },
      affiliateRows: [AFFILIATE],
    });
    const caught = await catchFrom(() =>
      validateOfferAffiliateBrands(
        strapi,
        uid,
        'update',
        { brands: { set: [AFFILIATE] } },
        'offer-1',
      ),
    );
    expect((caught as Error).message).toContain('cannot be combined with a Store');
  });

  it('normalizes bare-id shorthand payloads', async () => {
    const { strapi } = harness({ affiliateRows: [AFFILIATE] });
    const caught = await catchFrom(() =>
      validateOfferAffiliateBrands(strapi, uid, 'create', {
        brands: 'brand-aff',
        stores: 'store-1',
      }),
    );
    expect((caught as Error).message).toContain('cannot be combined with a Store');
  });

  it('resolves an untouched checkout merchant from the stored row', async () => {
    const { strapi } = harness({
      current: {
        stores: [],
        brands: [],
        checkoutMerchant: 'store:store-1',
      },
      affiliateRows: [AFFILIATE],
    });
    const caught = await catchFrom(() =>
      validateOfferAffiliateBrands(
        strapi,
        uid,
        'update',
        { brands: [AFFILIATE] },
        'offer-1',
      ),
    );
    expect(errorPaths(caught)).toEqual([['checkoutMerchant']]);
  });
});

describe('validateEntityOfferAffiliateConnections', () => {
  const CLEAN_OFFER = {
    id: 300,
    documentId: 'offer-clean',
    title: 'Clean offer',
    checkoutMerchant: null,
    stores: [],
    brands: [],
  };
  const AFFILIATE_OFFER = {
    id: 301,
    documentId: 'offer-affiliate',
    title: 'Affiliate offer',
    checkoutMerchant: null,
    stores: [],
    brands: [{ id: 9, documentId: 'brand-aff', name: 'AffBrand', isAffiliate: true }],
  };
  const STORE_OFFER = {
    id: 302,
    documentId: 'offer-store',
    title: 'Store offer',
    checkoutMerchant: null,
    stores: [{ id: 1 }],
    brands: [],
  };

  function entityHarness({
    current = null as unknown,
    coupons = [] as unknown[],
    deals = [] as unknown[],
  } = {}) {
    const findOne = vi.fn().mockResolvedValue(current);
    const couponFindMany = vi.fn().mockResolvedValue(coupons);
    const dealFindMany = vi.fn().mockResolvedValue(deals);
    const strapi = {
      documents: vi.fn(() => ({ findOne })),
      db: {
        query: vi.fn((uid: string) =>
          uid === 'api::coupon.coupon'
            ? { findMany: couponFindMany }
            : { findMany: dealFindMany },
        ),
      },
    } as any;
    return { strapi, findOne, couponFindMany, dealFindMany };
  }

  it('skips a payload that does not touch the offer inverses', async () => {
    const { strapi, findOne } = entityHarness();
    await expect(
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon' },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects connecting a Store to an offer owned by an affiliate brand', async () => {
    const { strapi } = entityHarness({
      current: { coupons: [] },
      coupons: [AFFILIATE_OFFER],
    });
    const caught = await catchFrom(() =>
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::store.store',
        'update',
        { coupons: { connect: [{ id: 301, documentId: 'offer-affiliate' }] } },
        'store-1',
      ),
    );
    expect((caught as Error).message).toContain('AffBrand');
    expect((caught as Error).message).toContain('a Store cannot be attached');
    expect(errorPaths(caught)).toEqual([['coupons']]);
  });

  it('accepts connecting a Store to a clean offer', async () => {
    const { strapi } = entityHarness({
      current: { coupons: [] },
      coupons: [CLEAN_OFFER],
    });
    await expect(
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::store.store',
        'update',
        { coupons: { connect: [{ documentId: 'offer-clean' }] } },
        'store-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects connecting a plain brand to an affiliate-owned offer', async () => {
    const { strapi } = entityHarness({
      current: { isAffiliate: false, deals: [] },
      deals: [AFFILIATE_OFFER],
    });
    const caught = await catchFrom(() =>
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::brand.brand',
        'update',
        { deals: { connect: [{ documentId: 'offer-affiliate' }] } },
        'brand-plain',
      ),
    );
    expect(errorPaths(caught)).toEqual([['deals']]);
    expect((caught as Error).message).toContain('other brands cannot be attached');
  });

  it('rejects connecting an affiliate brand to an offer that has a store', async () => {
    const { strapi } = entityHarness({
      current: { isAffiliate: true, coupons: [] },
      coupons: [STORE_OFFER],
    });
    const caught = await catchFrom(() =>
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::brand.brand',
        'update',
        { coupons: { connect: [{ documentId: 'offer-store' }] } },
        'brand-aff',
      ),
    );
    expect((caught as Error).message).toContain('must be its only merchant');
  });

  it('lets an affiliate brand join a bare offer, honoring a same-payload flip', async () => {
    // isAffiliate arrives in the SAME payload; stored flag is false.
    const { strapi } = entityHarness({
      current: { isAffiliate: false, coupons: [] },
      coupons: [CLEAN_OFFER],
    });
    await expect(
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::brand.brand',
        'update',
        {
          isAffiliate: true,
          coupons: { connect: [{ documentId: 'offer-clean' }] },
        },
        'brand-aff',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects an affiliate brand joining an offer with a foreign checkout merchant', async () => {
    const { strapi } = entityHarness({
      current: { isAffiliate: true, coupons: [] },
      coupons: [
        { ...CLEAN_OFFER, checkoutMerchant: 'store:store-1' },
      ],
    });
    const caught = await catchFrom(() =>
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::brand.brand',
        'update',
        { coupons: { connect: [{ documentId: 'offer-clean' }] } },
        'brand-aff',
      ),
    );
    expect((caught as Error).message).toContain('different checkout merchant');
  });

  it('judges only NEWLY connected offers in a full-replacement payload', async () => {
    const { strapi, couponFindMany } = entityHarness({
      current: { coupons: [{ documentId: 'offer-affiliate' }] },
      coupons: [CLEAN_OFFER],
    });
    // offer-affiliate is already connected (legacy state) — only offer-clean
    // is an addition, so the lookup must exclude the legacy row.
    await expect(
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::store.store',
        'update',
        {
          coupons: [
            { documentId: 'offer-affiliate' },
            { documentId: 'offer-clean' },
          ],
        },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(couponFindMany).toHaveBeenCalledTimes(1);
    const where = couponFindMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('offer-clean');
    expect(JSON.stringify(where)).not.toContain('offer-affiliate');
  });

  it('passes a disconnect-only payload without any offer lookup', async () => {
    const { strapi, couponFindMany } = entityHarness({
      current: { coupons: [{ documentId: 'offer-affiliate' }] },
    });
    await expect(
      validateEntityOfferAffiliateConnections(
        strapi,
        'api::store.store',
        'update',
        { coupons: { disconnect: [{ documentId: 'offer-affiliate' }] } },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(couponFindMany).not.toHaveBeenCalled();
  });
});

describe('entity offer snapshots', () => {
  const snapshot = (
    coupons: string[],
    deals: string[] = [],
  ) => ({
    'api::coupon.coupon': new Set(coupons),
    'api::deal.deal': new Set(deals),
  });

  it('reads the stored membership as documentId sets', async () => {
    const findOne = vi.fn().mockResolvedValue({
      coupons: [{ documentId: 'offer-a' }, { documentId: 'offer-b' }],
      deals: [{ documentId: 'deal-a' }],
    });
    const strapi = { documents: vi.fn(() => ({ findOne })) } as any;

    const result = await snapshotEntityOfferRelations(
      strapi,
      'api::store.store',
      'store-1',
    );
    expect(result['api::coupon.coupon']).toEqual(new Set(['offer-a', 'offer-b']));
    expect(result['api::deal.deal']).toEqual(new Set(['deal-a']));
  });

  it('maps a missing document to empty sets', async () => {
    const strapi = {
      documents: vi.fn(() => ({ findOne: vi.fn().mockResolvedValue(null) })),
    } as any;
    const result = await snapshotEntityOfferRelations(
      strapi,
      'api::brand.brand',
      'brand-gone',
    );
    expect(result['api::coupon.coupon'].size).toBe(0);
    expect(result['api::deal.deal'].size).toBe(0);
  });

  it('diffs a replacement into removed + added, not just the named survivors', async () => {
    // Replacing [a, b] with [b, c]: a was REMOVED (the payload never names
    // it) and c added; b is unchanged and must not be invalidated.
    expect(
      diffEntityOfferSnapshots(
        snapshot(['offer-a', 'offer-b']),
        snapshot(['offer-b', 'offer-c']),
      ),
    ).toEqual([
      { uid: 'api::coupon.coupon', documentId: 'offer-a' },
      { uid: 'api::coupon.coupon', documentId: 'offer-c' },
    ]);
  });

  it('diffs a clear into every removed offer', async () => {
    expect(
      diffEntityOfferSnapshots(
        snapshot(['offer-a'], ['deal-a']),
        EMPTY_ENTITY_OFFER_SNAPSHOT,
      ),
    ).toEqual([
      { uid: 'api::coupon.coupon', documentId: 'offer-a' },
      { uid: 'api::deal.deal', documentId: 'deal-a' },
    ]);
  });

  it('diffs identical snapshots to nothing', async () => {
    expect(
      diffEntityOfferSnapshots(snapshot(['offer-a']), snapshot(['offer-a'])),
    ).toEqual([]);
  });
});

describe('detachAffiliateBrand', () => {
  function cascadeHarness({
    brand = { id: 9 } as unknown,
    coupons = [] as unknown[],
    deals = [] as unknown[],
  } = {}) {
    const brandFindOne = vi.fn().mockResolvedValue(brand);
    const couponFindMany = vi.fn().mockResolvedValue(coupons);
    const dealFindMany = vi.fn().mockResolvedValue(deals);
    const couponUpdate = vi.fn().mockResolvedValue(undefined);
    const dealUpdate = vi.fn().mockResolvedValue(undefined);
    const strapi = {
      db: {
        query: vi.fn((uid: string) => {
          if (uid === 'api::brand.brand') return { findOne: brandFindOne };
          if (uid === 'api::coupon.coupon')
            return { findMany: couponFindMany, update: couponUpdate };
          return { findMany: dealFindMany, update: dealUpdate };
        }),
      },
    } as any;
    return { strapi, couponUpdate, dealUpdate };
  }

  it('returns empty for an unknown brand', async () => {
    const { strapi, couponUpdate } = cascadeHarness({ brand: null });
    const result = await detachAffiliateBrand(strapi, 'brand-gone');
    expect(result.affected).toEqual([]);
    expect(couponUpdate).not.toHaveBeenCalled();
  });

  it('disconnects the brand from offers holding a store or other brands', async () => {
    const { strapi, couponUpdate } = cascadeHarness({
      coupons: [
        {
          id: 100,
          documentId: 'offer-store',
          checkoutMerchant: null,
          stores: [{ id: 1 }],
          brands: [{ id: 9 }],
        },
        {
          id: 101,
          documentId: 'offer-multibrand',
          checkoutMerchant: null,
          stores: [],
          brands: [{ id: 9 }, { id: 5 }],
        },
      ],
    });

    const result = await detachAffiliateBrand(strapi, 'brand-aff');

    expect(couponUpdate).toHaveBeenCalledTimes(2);
    expect(couponUpdate).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { brands: { disconnect: [9] } },
    });
    expect(result.detachedCount).toBe(2);
    expect(result.affected).toEqual([
      { uid: 'api::coupon.coupon', documentId: 'offer-store' },
      { uid: 'api::coupon.coupon', documentId: 'offer-multibrand' },
    ]);
  });

  it('clears a conflicting checkout merchant on offers the brand stays sole on', async () => {
    const { strapi, couponUpdate } = cascadeHarness({
      coupons: [
        {
          id: 102,
          documentId: 'offer-sole',
          checkoutMerchant: 'store:store-1',
          stores: [],
          brands: [{ id: 9 }],
        },
      ],
    });

    const result = await detachAffiliateBrand(strapi, 'brand-aff');

    expect(couponUpdate).toHaveBeenCalledWith({
      where: { id: 102 },
      data: { checkoutMerchant: null },
    });
    expect(result.detachedCount).toBe(0);
    expect(result.merchantsClearedCount).toBe(1);
    expect(result.affected).toEqual([
      { uid: 'api::coupon.coupon', documentId: 'offer-sole' },
    ]);
  });

  it('leaves clean sole-brand offers untouched', async () => {
    const { strapi, couponUpdate, dealUpdate } = cascadeHarness({
      coupons: [
        {
          id: 103,
          documentId: 'offer-clean',
          checkoutMerchant: 'brand:brand-aff',
          stores: [],
          brands: [{ id: 9 }],
        },
        {
          id: 104,
          documentId: 'offer-empty-merchant',
          checkoutMerchant: null,
          stores: [],
          brands: [{ id: 9 }],
        },
      ],
    });

    const result = await detachAffiliateBrand(strapi, 'brand-aff');

    expect(couponUpdate).not.toHaveBeenCalled();
    expect(dealUpdate).not.toHaveBeenCalled();
    expect(result.affected).toEqual([]);
  });

  it('sweeps deals as well as coupons', async () => {
    const { strapi, dealUpdate } = cascadeHarness({
      deals: [
        {
          id: 200,
          documentId: 'deal-store',
          checkoutMerchant: null,
          stores: [{ id: 2 }],
          brands: [{ id: 9 }],
        },
      ],
    });

    const result = await detachAffiliateBrand(strapi, 'brand-aff');

    expect(dealUpdate).toHaveBeenCalledWith({
      where: { id: 200 },
      data: { brands: { disconnect: [9] } },
    });
    expect(result.affected).toEqual([
      { uid: 'api::deal.deal', documentId: 'deal-store' },
    ]);
  });
});
