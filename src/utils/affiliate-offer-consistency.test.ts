import { describe, expect, it, vi } from 'vitest';

import {
  normaliseAffiliateOfferFields,
  validateAffiliateBrandFlip,
  validateAffiliateOfferForWrite,
} from './affiliate-offer-consistency';
import type { AffiliateOfferUid } from '../constants/affiliate-offer';
import couponSchema from '../api/coupon/content-types/coupon/schema.json';
import dealSchema from '../api/deal/content-types/deal/schema.json';

const STORE_ONE = { id: 1, documentId: 'store-1' };
const AFFILIATE_BRAND = {
  id: 10,
  documentId: 'brand-aff',
  name: 'Affiliate Brand',
  isAffiliateStore: true,
};
const PLAIN_BRAND = {
  id: 11,
  documentId: 'brand-plain',
  name: 'Plain Brand',
  isAffiliateStore: false,
};

function harness({
  path = '/content-manager/collection-types/api::coupon.coupon/coupon-1',
  storedOffer = null,
  storedBrand = null,
  brandRows = [],
  offerCounts = {},
}: {
  path?: string | null;
  storedOffer?: unknown;
  storedBrand?: unknown;
  brandRows?: unknown[];
  offerCounts?: Record<string, number>;
} = {}) {
  const offerFindOne = vi.fn().mockResolvedValue(storedOffer);
  const brandFindOne = vi.fn().mockResolvedValue(storedBrand);
  const documents = vi.fn((uid: string) => {
    if (uid === 'api::brand.brand') return { findOne: brandFindOne };
    return {
      findOne: offerFindOne,
      count: vi.fn(async () => offerCounts[uid] ?? 0),
    };
  });
  const findMany = vi.fn().mockResolvedValue(brandRows);
  return {
    strapi: {
      requestContext: { get: () => (path == null ? undefined : { path }) },
      documents,
      db: { query: vi.fn(() => ({ findMany })) },
    } as any,
    offerFindOne,
    brandFindOne,
    findMany,
    documents,
  };
}

const errorPaths = (error: unknown) =>
  (error as { details?: { errors?: { path?: string[] }[] } }).details?.errors?.map(
    (entry) => entry.path,
  );

describe('affiliate offer schema defaults', () => {
  it.each([
    ['coupon', couponSchema],
    ['deal', dealSchema],
  ])('starts each new %s as an affiliate-brand offer', (_name, schema) => {
    expect(schema.attributes.isForAffiliateBrand).toEqual({
      type: 'boolean',
      default: true,
    });
  });
});

describe('normaliseAffiliateOfferFields', () => {
  it('leaves a payload without the toggle byte-identical', () => {
    const data = {
      title: 'Offer',
      logoStore: { documentId: 'store-1' },
      checkoutMerchant: 'store:store-1',
    };
    const before = structuredClone(data);

    expect(normaliseAffiliateOfferFields(data)).toBe(data);
    expect(data).toEqual(before);
  });

  it('clears logoStore and checkoutMerchant when the toggle turns ON', () => {
    const data: Record<string, unknown> = {
      isForAffiliateBrand: true,
      logoStore: { documentId: 'store-1' },
      checkoutMerchant: 'store:store-1',
    };

    normaliseAffiliateOfferFields(data);

    expect(data.logoStore).toBeNull();
    expect(data.checkoutMerchant).toBeNull();
  });

  it('sets the cleared fields even when absent from the payload (admin omits hidden fields)', () => {
    const data: Record<string, unknown> = { isForAffiliateBrand: true };

    normaliseAffiliateOfferFields(data);

    expect(data).toEqual({
      isForAffiliateBrand: true,
      logoStore: null,
      checkoutMerchant: null,
    });
  });

  it('owns nothing when the toggle is present but OFF (false or null)', () => {
    for (const toggle of [false, null, undefined]) {
      const data: Record<string, unknown> = {
        isForAffiliateBrand: toggle,
        logoStore: { documentId: 'store-1' },
        checkoutMerchant: 'store:store-1',
      };
      const before = structuredClone(data);

      normaliseAffiliateOfferFields(data);

      expect(data).toEqual(before);
    }
  });

  it('passes non-object payloads through', () => {
    expect(normaliseAffiliateOfferFields(null)).toBeNull();
    expect(normaliseAffiliateOfferFields(undefined)).toBeUndefined();
    expect(normaliseAffiliateOfferFields('nope')).toBe('nope');
  });
});

describe.each([
  'api::coupon.coupon',
  'api::deal.deal',
] as AffiliateOfferUid[])('validateAffiliateOfferForWrite — %s', (uid) => {
  it('accepts create with the toggle ON, affiliate brands only and no stores', async () => {
    const { strapi } = harness({ brandRows: [AFFILIATE_BRAND] });

    await expect(
      validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: true,
        brands: [AFFILIATE_BRAND],
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects create with the toggle ON and stores selected', async () => {
    const { strapi } = harness();
    let caught: unknown;
    try {
      await validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain('cannot have Stores');
    expect(errorPaths(caught)).toEqual([['stores']]);
  });

  it('rejects create with a non-affiliate brand and names it', async () => {
    const { strapi } = harness({ brandRows: [AFFILIATE_BRAND, PLAIN_BRAND] });
    let caught: unknown;
    try {
      await validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: true,
        brands: [AFFILIATE_BRAND, PLAIN_BRAND],
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain('Plain Brand');
    expect((caught as Error).message).not.toContain('Affiliate Brand,');
    expect(errorPaths(caught)).toEqual([['brands']]);
  });

  it('does nothing when the toggle is OFF or absent with no stored toggle', async () => {
    const { strapi, findMany } = harness();

    await expect(
      validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: false,
        stores: [STORE_ONE],
        brands: [PLAIN_BRAND],
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateAffiliateOfferForWrite(strapi, uid, 'create', {
        stores: [STORE_ONE],
      }),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('validateAffiliateOfferForWrite — stored state and payload shapes', () => {
  const uid: AffiliateOfferUid = 'api::coupon.coupon';

  it('catches a stored-ON offer dirtied with a store on an unrelated admin save', async () => {
    const { strapi, offerFindOne } = harness({
      storedOffer: {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
        brands: [AFFILIATE_BRAND],
      },
      brandRows: [AFFILIATE_BRAND],
    });

    await expect(
      validateAffiliateOfferForWrite(
        strapi,
        uid,
        'update',
        { title: 'Unrelated edit' },
        'coupon-1',
      ),
    ).rejects.toThrow('cannot have Stores');
    expect(offerFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'coupon-1' }),
    );
  });

  it('accepts an update that fixes the violation in the same save', async () => {
    const { strapi } = harness({
      storedOffer: {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
        brands: [PLAIN_BRAND],
      },
      brandRows: [AFFILIATE_BRAND],
    });

    await expect(
      validateAffiliateOfferForWrite(
        strapi,
        uid,
        'update',
        {
          isForAffiliateBrand: true,
          stores: { disconnect: [STORE_ONE] },
          brands: {
            connect: [AFFILIATE_BRAND],
            disconnect: [PLAIN_BRAND],
          },
        },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects payload-explicit logoStore and checkoutMerchant while ON', async () => {
    const { strapi } = harness();
    let caught: unknown;
    try {
      await validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: true,
        logoStore: { documentId: 'store-1' },
        checkoutMerchant: 'store:store-1',
      });
    } catch (error) {
      caught = error;
    }

    expect(errorPaths(caught)).toEqual([['logoStore'], ['checkoutMerchant']]);
  });

  it('accepts cleared logoStore/checkoutMerchant while ON (the normalised payload)', async () => {
    const { strapi } = harness();

    await expect(
      validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: true,
        logoStore: null,
        checkoutMerchant: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('collects every problem into one error', async () => {
    const { strapi } = harness({ brandRows: [PLAIN_BRAND] });
    let caught: unknown;
    try {
      await validateAffiliateOfferForWrite(strapi, uid, 'create', {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
        brands: [PLAIN_BRAND],
        logoStore: 'store-1',
        checkoutMerchant: 'brand:brand-plain',
      });
    } catch (error) {
      caught = error;
    }

    expect(errorPaths(caught)).toEqual([
      ['stores'],
      ['brands'],
      ['logoStore'],
      ['checkoutMerchant'],
    ]);
  });

  it('resolves shorthand and set relation payloads', async () => {
    const shorthand = harness({ brandRows: [AFFILIATE_BRAND] });
    await expect(
      validateAffiliateOfferForWrite(shorthand.strapi, uid, 'create', {
        isForAffiliateBrand: true,
        brands: 'brand-aff',
      }),
    ).resolves.toBeUndefined();

    const set = harness({
      storedOffer: {
        isForAffiliateBrand: true,
        stores: [],
        brands: [PLAIN_BRAND],
      },
      brandRows: [AFFILIATE_BRAND],
    });
    await expect(
      validateAffiliateOfferForWrite(
        set.strapi,
        uid,
        'update',
        { brands: { set: [AFFILIATE_BRAND] } },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('validates clone against the source document state', async () => {
    const { strapi } = harness({
      storedOffer: {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
        brands: [],
      },
    });

    await expect(
      validateAffiliateOfferForWrite(
        strapi,
        uid,
        'clone',
        { title: 'Copy' },
        'coupon-source',
      ),
    ).rejects.toThrow('cannot have Stores');
  });

  it('is fully exempt for non-Content-Manager writes', async () => {
    const background = harness({ path: null });
    await expect(
      validateAffiliateOfferForWrite(background.strapi, uid, 'update', {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
      }),
    ).resolves.toBeUndefined();
    expect(background.offerFindOne).not.toHaveBeenCalled();

    const publicApi = harness({ path: '/api/coupons/coupon-1' });
    await expect(
      validateAffiliateOfferForWrite(publicApi.strapi, uid, 'update', {
        isForAffiliateBrand: true,
        stores: [STORE_ONE],
      }),
    ).resolves.toBeUndefined();
  });

  it('enforces the invariant for an explicit translation publication', async () => {
    const background = harness({ path: null });

    await expect(
      validateAffiliateOfferForWrite(
        background.strapi,
        uid,
        'create',
        { isForAffiliateBrand: true, stores: [STORE_ONE] },
        undefined,
        true,
      ),
    ).rejects.toThrow('cannot have Stores');
  });
});

describe('validateAffiliateBrandFlip', () => {
  const BRAND_UID = 'api::brand.brand';

  it('reads nothing when the flag is not in the payload', async () => {
    const { strapi, brandFindOne } = harness();

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { name: 'Renamed' },
        'brand-1',
      ),
    ).resolves.toBeUndefined();
    expect(brandFindOne).not.toHaveBeenCalled();
  });

  it('reads nothing when the flag is set to true', async () => {
    const { strapi, brandFindOne } = harness();

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { isAffiliateStore: true },
        'brand-1',
      ),
    ).resolves.toBeUndefined();
    expect(brandFindOne).not.toHaveBeenCalled();
  });

  it('stops after one read when the stored flag was never on', async () => {
    const { strapi, brandFindOne, documents } = harness({
      storedBrand: { documentId: 'brand-1', isAffiliateStore: false },
    });

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { isAffiliateStore: false },
        'brand-1',
      ),
    ).resolves.toBeUndefined();
    expect(brandFindOne).toHaveBeenCalledTimes(1);
    // Only the brand document service was touched — no offer counts.
    expect(documents).toHaveBeenCalledTimes(1);
    expect(documents).toHaveBeenCalledWith(BRAND_UID);
  });

  it('allows a real flip with zero referencing affiliate offers', async () => {
    const { strapi } = harness({
      storedBrand: { documentId: 'brand-1', isAffiliateStore: true },
      offerCounts: {},
    });

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { isAffiliateStore: false },
        'brand-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a flip while affiliate offers still reference the brand', async () => {
    const { strapi } = harness({
      storedBrand: { documentId: 'brand-1', isAffiliateStore: true },
      offerCounts: { 'api::coupon.coupon': 2, 'api::deal.deal': 1 },
    });
    let caught: unknown;
    try {
      await validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { isAffiliateStore: false },
        'brand-1',
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain('3 affiliate offers still reference');
    expect(errorPaths(caught)).toEqual([['isAffiliateStore']]);
  });

  it('uses singular phrasing for one referencing offer', async () => {
    const { strapi } = harness({
      storedBrand: { documentId: 'brand-1', isAffiliateStore: true },
      offerCounts: { 'api::deal.deal': 1 },
    });

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { isAffiliateStore: false },
        'brand-1',
      ),
    ).rejects.toThrow('1 affiliate offer still references');
  });

  it('is NOT Content-Manager-gated: an explicit background flip is blocked too', async () => {
    const { strapi } = harness({
      path: null,
      storedBrand: { documentId: 'brand-1', isAffiliateStore: true },
      offerCounts: { 'api::coupon.coupon': 1 },
    });

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'update',
        { isAffiliateStore: false },
        'brand-1',
      ),
    ).rejects.toThrow('still references');
  });

  it('ignores create and other uids', async () => {
    const { strapi, brandFindOne } = harness();

    await expect(
      validateAffiliateBrandFlip(
        strapi,
        BRAND_UID,
        'create',
        { isAffiliateStore: false },
        undefined,
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateAffiliateBrandFlip(
        strapi,
        'api::store.store',
        'update',
        { isAffiliateStore: false },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(brandFindOne).not.toHaveBeenCalled();
  });
});
