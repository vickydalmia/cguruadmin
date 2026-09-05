import { describe, expect, it, vi } from 'vitest';

import {
  validateContentManagerOfferStore,
  type OfferStoreUid,
} from './content-manager-offer-store-validation';

const STORE_ONE = { id: 1, documentId: 'store-1' };
const STORE_TWO = { id: 2, documentId: 'store-2' };
const STORE_THREE = { id: 3, documentId: 'store-3' };

describe('translation source store preservation', () => {
  it.each(['create', 'update'])('preserves the two source stores on %s', async (action) => {
    const { strapi } = harness({ path: null });
    await expect(validateContentManagerOfferStore(
      strapi, 'api::coupon.coupon', action,
      { stores: { set: [{ documentId: 'store-1' }, { documentId: 'store-2' }] } },
      'coupon-1', true, { stores: [STORE_ONE, STORE_TWO] }, 'ar',
    )).resolves.toBeUndefined();
  });

  it('rejects a changed multi-store list even with translation context', async () => {
    const { strapi } = harness({ path: null });
    await expect(validateContentManagerOfferStore(
      strapi, 'api::coupon.coupon', 'create',
      { stores: { set: [STORE_ONE, STORE_THREE] } },
      'coupon-1', true, { stores: [STORE_ONE, STORE_TWO] }, 'ar',
    )).rejects.toThrow('At most one Store');
  });

  it('reads the Arabic target for updates and does not forgive target-only legacy stores', async () => {
    const { strapi, findOne } = harness({ path: null, currentStores: [STORE_ONE, STORE_TWO] });
    await expect(validateContentManagerOfferStore(
      strapi, 'api::coupon.coupon', 'update', {}, 'coupon-1', true,
      { stores: [STORE_ONE] }, 'ar',
    )).rejects.toThrow('At most one Store');
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ar' }));
  });
});

function harness({
  path = '/content-manager/collection-types/api::coupon.coupon/coupon-1',
  currentStores = [],
}: {
  path?: string | null;
  currentStores?: unknown[];
} = {}) {
  const findOne = vi.fn().mockResolvedValue({ stores: currentStores });
  return {
    strapi: {
      requestContext: { get: () => (path == null ? undefined : { path }) },
      documents: vi.fn(() => ({ findOne })),
    } as any,
    findOne,
  };
}

const validate = (
  strapi: any,
  uid: OfferStoreUid,
  action: string,
  data: unknown,
  documentId?: string,
) => validateContentManagerOfferStore(strapi, uid, action, data, documentId);

const errorPaths = (error: unknown) =>
  (error as { details?: { errors?: { path?: string[] }[] } }).details?.errors?.map(
    (entry) => entry.path,
  );

describe.each([
  'api::coupon.coupon',
  'api::deal.deal',
] as OfferStoreUid[])('Content Manager optional single-Store validation — %s', (uid) => {
  it('accepts create with zero Stores', async () => {
    const { strapi } = harness();

    await expect(validate(strapi, uid, 'create', {})).resolves.toBeUndefined();
  });

  it('accepts create with one Store', async () => {
    const { strapi } = harness();

    await expect(
      validate(strapi, uid, 'create', { stores: [STORE_ONE] }),
    ).resolves.toBeUndefined();
  });

  it('rejects create with multiple Stores and reports stores as the path', async () => {
    const { strapi } = harness();
    let caught: unknown;
    try {
      await validate(strapi, uid, 'create', {
        stores: [STORE_ONE, STORE_TWO],
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain('currently has 2 Stores');
    expect(errorPaths(caught)).toEqual([['stores']]);
  });
});

describe('Content Manager optional single-Store relation payloads', () => {
  const uid: OfferStoreUid = 'api::coupon.coupon';

  it('resolves direct arrays and set commands', async () => {
    const direct = harness({ currentStores: [STORE_ONE, STORE_TWO] });
    await expect(
      validate(
        direct.strapi,
        uid,
        'update',
        { stores: [STORE_THREE] },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();

    const set = harness({ currentStores: [STORE_ONE] });
    await expect(
      validate(
        set.strapi,
        uid,
        'update',
        { stores: { set: [STORE_TWO, STORE_THREE] } },
        'coupon-1',
      ),
    ).rejects.toThrow('currently has 2 Stores');
  });

  it('resolves document-service shorthand relation values', async () => {
    const scalar = harness({ currentStores: [] });
    await expect(
      validate(scalar.strapi, uid, 'update', { stores: 'store-1' }, 'coupon-1'),
    ).resolves.toBeUndefined();

    const bareObject = harness({ currentStores: [STORE_ONE, STORE_TWO] });
    await expect(
      validate(
        bareObject.strapi,
        uid,
        'update',
        { stores: { documentId: 'store-3' } },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();

    // Explicit null clears the optional relation.
    const cleared = harness({ currentStores: [STORE_ONE] });
    await expect(
      validate(cleared.strapi, uid, 'update', { stores: null }, 'coupon-1'),
    ).resolves.toBeUndefined();
  });

  it('accepts an atomic Content Manager replacement', async () => {
    const { strapi } = harness({ currentStores: [STORE_ONE] });

    await expect(
      validate(
        strapi,
        uid,
        'update',
        {
          stores: {
            connect: [STORE_TWO],
            disconnect: [STORE_ONE],
          },
        },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves connect/disconnect against all stored relations', async () => {
    const { strapi } = harness({
      currentStores: [STORE_ONE, STORE_TWO, STORE_THREE],
    });

    await expect(
      validate(
        strapi,
        uid,
        'update',
        { stores: { disconnect: [STORE_ONE, STORE_THREE] } },
        'coupon-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('blocks a legacy multi-Store record on an unrelated admin save', async () => {
    const { strapi, findOne } = harness({
      currentStores: [STORE_ONE, STORE_TWO],
    });

    await expect(
      validate(strapi, uid, 'update', { title: 'Unrelated edit' }, 'coupon-1'),
    ).rejects.toThrow('currently has 2 Stores');
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'coupon-1' }),
    );
  });

  it('validates clone against the source relation plus clone data', async () => {
    const valid = harness({ currentStores: [STORE_ONE] });
    await expect(
      validate(valid.strapi, uid, 'clone', { title: 'Copy' }, 'coupon-source'),
    ).resolves.toBeUndefined();

    const invalid = harness({ currentStores: [STORE_ONE, STORE_TWO] });
    await expect(
      validate(
        invalid.strapi,
        uid,
        'clone',
        { stores: { set: [STORE_THREE] } },
        'coupon-source',
      ),
    ).resolves.toBeUndefined();
    await expect(
      validate(
        invalid.strapi,
        uid,
        'clone',
        { title: 'Unclean copy' },
        'coupon-source',
      ),
    ).rejects.toThrow('currently has 2 Stores');
  });
});

describe('optional single-Store validation scope', () => {
  const uid: OfferStoreUid = 'api::deal.deal';

  it('does not restrict background writes', async () => {
    const { strapi, findOne } = harness({
      path: null,
      currentStores: [STORE_ONE, STORE_TWO],
    });

    await expect(
      validate(strapi, uid, 'update', { contentStatus: 'expired' }, 'deal-1'),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('does not restrict custom or public API writes', async () => {
    const { strapi, findOne } = harness({
      path: '/api/deals/deal-1',
      currentStores: [STORE_ONE, STORE_TWO],
    });

    await expect(
      validate(
        strapi,
        uid,
        'update',
        { stores: [STORE_ONE, STORE_TWO] },
        'deal-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('enforces the invariant for an explicit translation publication', async () => {
    const { strapi } = harness({ path: null });

    await expect(
      validateContentManagerOfferStore(
        strapi,
        uid,
        'create',
        { stores: [STORE_ONE, STORE_TWO] },
        undefined,
        true,
      ),
    ).rejects.toThrow('currently has 2 Stores');
  });
});
