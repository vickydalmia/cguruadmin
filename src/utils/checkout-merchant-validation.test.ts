import { describe, expect, it, vi } from 'vitest';

import {
  clearDeletedCheckoutMerchant,
  validateCheckoutMerchantForWrite,
} from './checkout-merchant-validation';

const COUPON = 'api::coupon.coupon';
const DEAL = 'api::deal.deal';

/**
 * A strapi double whose document service answers findOne per uid.
 *
 * `rows` maps `<uid>:<documentId>` to the row that lookup should return;
 * anything absent resolves to null, which is exactly how a deleted target
 * behaves.
 */
const strapiWith = (rows: Record<string, unknown>) => {
  const findOne = vi.fn(async ({ documentId }: any) => documentId);
  return {
    findOne,
    strapi: {
      documents: (uid: string) => ({
        findOne: async ({ documentId }: any) => {
          findOne({ uid, documentId });
          return rows[`${uid}:${documentId}`] ?? null;
        },
      }),
    } as any,
  };
};

const LIVE = {
  'api::store.store:store123': { name: 'Amazon' },
  'api::brand.brand:brand456': { name: 'Nike' },
};

describe('validateCheckoutMerchantForWrite', () => {
  it('is a no-op for content types without the field', async () => {
    const { strapi } = strapiWith({});
    await expect(
      validateCheckoutMerchantForWrite(strapi, 'api::store.store', 'update', {
        checkoutMerchant: 'store:nope',
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the payload does not touch the field', async () => {
    // Grandfathering: an editor fixing a typo on a legacy offer whose merchant
    // was deleted must not be blocked by a field they never touched.
    const { strapi, findOne } = strapiWith({});
    await expect(
      validateCheckoutMerchantForWrite(strapi, COUPON, 'update', {
        title: 'New title',
      }),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('accepts a reference to a live Store and to a live Brand', async () => {
    const { strapi } = strapiWith(LIVE);
    for (const value of ['store:store123', 'brand:brand456']) {
      await expect(
        validateCheckoutMerchantForWrite(strapi, DEAL, 'create', {
          checkoutMerchant: value,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('accepts clearing the field', async () => {
    const { strapi, findOne } = strapiWith(LIVE);
    for (const value of [null, '', '   ']) {
      await expect(
        validateCheckoutMerchantForWrite(strapi, COUPON, 'update', {
          checkoutMerchant: value,
        }),
      ).resolves.toBeUndefined();
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects a malformed reference with an inline field path', async () => {
    const { strapi } = strapiWith(LIVE);
    try {
      await validateCheckoutMerchantForWrite(strapi, COUPON, 'update', {
        checkoutMerchant: 'Amazon',
      });
      throw new Error('expected to throw');
    } catch (err: any) {
      expect(err.details?.errors?.[0]?.path).toEqual(['checkoutMerchant']);
      expect(err.message).toMatch(/store:<id>/);
    }
  });

  it('rejects a kind that is not Store or Brand', async () => {
    const { strapi } = strapiWith(LIVE);
    await expect(
      validateCheckoutMerchantForWrite(strapi, COUPON, 'update', {
        checkoutMerchant: 'bank:store123',
      }),
    ).rejects.toThrow(/not a valid reference/);
  });

  it('rejects a reference to a target that no longer exists', async () => {
    // The half a foreign key would have caught. Without it, a deleted Store
    // leaves a live offer pointing at nothing.
    const { strapi } = strapiWith(LIVE);
    try {
      await validateCheckoutMerchantForWrite(strapi, DEAL, 'update', {
        checkoutMerchant: 'store:deletedStore',
      });
      throw new Error('expected to throw');
    } catch (err: any) {
      expect(err.details?.errors?.[0]?.path).toEqual(['checkoutMerchant']);
      expect(err.message).toMatch(/no longer exists/);
    }
  });

  it('names the right entity type in the message', async () => {
    const { strapi } = strapiWith(LIVE);
    await expect(
      validateCheckoutMerchantForWrite(strapi, DEAL, 'update', {
        checkoutMerchant: 'brand:deletedBrand',
      }),
    ).rejects.toThrow(/Brand that no longer exists/);
  });

  it('rejects a value longer than the column cap', async () => {
    const { strapi } = strapiWith(LIVE);
    await expect(
      validateCheckoutMerchantForWrite(strapi, COUPON, 'create', {
        checkoutMerchant: `store:${'a'.repeat(200)}`,
      }),
    ).rejects.toThrow(/at most 64 characters/);
  });

  it('does not run for non-write actions', async () => {
    const { strapi } = strapiWith({});
    await expect(
      validateCheckoutMerchantForWrite(strapi, COUPON, 'delete', {
        checkoutMerchant: 'store:gone',
      }),
    ).resolves.toBeUndefined();
  });

  it('lets a lookup failure through rather than blocking a valid save', async () => {
    // An unreadable database is not proof the target is missing, and
    // rejecting here would strand an editor on a transient error.
    const strapi = {
      documents: () => ({
        findOne: async () => {
          throw new Error('connection reset');
        },
      }),
    } as any;
    await expect(
      validateCheckoutMerchantForWrite(strapi, COUPON, 'update', {
        checkoutMerchant: 'store:store123',
      }),
    ).resolves.toBeUndefined();
  });

  describe('strict ("clean as you touch") mode', () => {
    it('judges the stored value on a payload that omits the field', async () => {
      const { strapi } = strapiWith(LIVE);
      const stored = {
        documents: (uid: string) => ({
          findOne: async ({ documentId }: any) => {
            if (uid === COUPON) return { checkoutMerchant: 'store:deletedStore' };
            return (LIVE as any)[`${uid}:${documentId}`] ?? null;
          },
        }),
      } as any;
      void strapi;
      await expect(
        validateCheckoutMerchantForWrite(
          stored,
          COUPON,
          'update',
          { title: 'x' },
          'coupon1',
          true,
        ),
      ).rejects.toThrow(/no longer exists/);
    });

    it('non-strict passes the same untouched dangling stored value', async () => {
      const stored = {
        documents: () => ({
          findOne: async () => ({ checkoutMerchant: 'store:deletedStore' }),
        }),
      } as any;
      await expect(
        validateCheckoutMerchantForWrite(
          stored,
          COUPON,
          'update',
          { title: 'x' },
          'coupon1',
          false,
        ),
      ).resolves.toBeUndefined();
    });
  });
});

describe('clearDeletedCheckoutMerchant', () => {
  const queryDouble = (counts: Record<string, number>) => {
    const calls: any[] = [];
    return {
      calls,
      strapi: {
        db: {
          query: (uid: string) => ({
            updateMany: async (args: any) => {
              calls.push({ uid, ...args });
              return { count: counts[uid] ?? 0 };
            },
          }),
        },
      } as any,
    };
  };

  it('nulls the reference on both offer types and totals the count', async () => {
    const { strapi, calls } = queryDouble({
      [COUPON]: 3,
      [DEAL]: 2,
    });

    await expect(
      clearDeletedCheckoutMerchant(strapi, 'store', 'store123'),
    ).resolves.toBe(5);

    expect(calls.map((call) => call.uid)).toEqual([COUPON, DEAL]);
    for (const call of calls) {
      expect(call.where).toEqual({ checkoutMerchant: 'store:store123' });
      expect(call.data).toEqual({ checkoutMerchant: null });
    }
  });

  it('targets brand references by their own prefix', async () => {
    const { strapi, calls } = queryDouble({});
    await clearDeletedCheckoutMerchant(strapi, 'brand', 'brand456');
    expect(calls[0].where).toEqual({ checkoutMerchant: 'brand:brand456' });
  });

  it('survives a driver that does not return a count', async () => {
    const strapi = {
      db: { query: () => ({ updateMany: async () => undefined }) },
    } as any;
    await expect(
      clearDeletedCheckoutMerchant(strapi, 'store', 'store123'),
    ).resolves.toBe(0);
  });
});
