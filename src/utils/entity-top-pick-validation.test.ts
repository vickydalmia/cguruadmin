import { describe, expect, it, vi } from 'vitest';
import {
  validateEntityTopPickCoupons,
} from './entity-top-pick-validation';

function harness(current: unknown = null, eligible: unknown[] = []) {
  const findOne = vi.fn().mockResolvedValue(current);
  const findMany = vi.fn().mockResolvedValue(eligible);
  return {
    strapi: {
      documents: vi.fn((uid: string) =>
        uid === 'api::coupon.coupon' ? { findMany } : { findOne },
      ),
    } as any,
    findOne,
    findMany,
  };
}

describe('entity Top Pick Coupon selection rules', () => {
  it('accepts up to four selected Coupons', async () => {
    const selected = Array.from({ length: 4 }, (_, id) => ({ id: id + 1 }));
    const { strapi, findMany } = harness(null, selected);

    await expect(
      validateEntityTopPickCoupons(
        strapi,
        'api::store.store',
        { topPickCoupons: selected },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          $and: expect.arrayContaining([
            { stores: { documentId: 'store-1' } },
          ]),
        }),
      }),
    );
  });

  it.each([
    'api::store.store',
    'api::brand.brand',
    'api::bank.bank',
    'api::category.category',
  ] as const)('rejects a fifth Coupon for %s', async (uid) => {
    const { strapi } = harness();

    await expect(
      validateEntityTopPickCoupons(strapi, uid, {
        topPickCoupons: Array.from({ length: 5 }, (_, id) => ({ id })),
      }),
    ).rejects.toMatchObject({
      details: {
        errors: [expect.objectContaining({ path: ['topPickCoupons'] })],
      },
    });
  });

  it('resolves Content Manager connect/disconnect patches against stored selections', async () => {
    const { strapi, findOne } = harness({
      topPickCoupons: Array.from({ length: 4 }, (_, id) => ({ id: id + 1 })),
    });

    await expect(
      validateEntityTopPickCoupons(
        strapi,
        'api::category.category',
        { topPickCoupons: { connect: [{ id: 5 }], disconnect: [] } },
        'category-1',
      ),
    ).rejects.toThrow(/at most 4 Coupons/);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'category-1' }),
    );
  });

  it('skips unrelated entity updates', async () => {
    const { strapi, findOne } = harness();

    await validateEntityTopPickCoupons(
      strapi,
      'api::brand.brand',
      { name: 'Updated brand' },
      'brand-1',
    );

    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects a Coupon that is not related to the edited entity', async () => {
    const { strapi } = harness(null, [
      { id: 13, documentId: 'coupon-13' },
    ]);

    await expect(
      validateEntityTopPickCoupons(
        strapi,
        'api::bank.bank',
        {
          topPickCoupons: [
            { id: 12, documentId: 'coupon-12' },
            { id: 13, documentId: 'coupon-13' },
          ],
        },
        'bank-1',
      ),
    ).rejects.toThrow(/related to this bank/);
  });

  it('requires the entity to be saved before Top Pick Coupons can be selected', async () => {
    const { strapi, findMany } = harness();

    await expect(
      validateEntityTopPickCoupons(strapi, 'api::brand.brand', {
        topPickCoupons: [
          { id: 3, documentId: 'coupon-3' },
          { id: 4, documentId: 'coupon-4' },
        ],
      }),
    ).rejects.toThrow(/Save this entity before selecting/);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('accepts a single curated Coupon', async () => {
    // There is no minimum. The storefront keeps a lone pick in slot one and
    // fills slot two with the newest eligible Coupon, so requiring two only
    // forced editors to pad a selection they did not want.
    const selected = [{ id: 1, documentId: 'coupon-1' }];
    const { strapi } = harness(null, selected);

    await expect(
      validateEntityTopPickCoupons(
        strapi,
        'api::store.store',
        { topPickCoupons: selected },
        'store-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts an empty selection without querying Coupons', async () => {
    const { strapi, findMany } = harness();

    await expect(
      validateEntityTopPickCoupons(
        strapi,
        'api::store.store',
        { topPickCoupons: [] },
        'store-1',
      ),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('still rejects a lone Coupon that is not related to the entity', async () => {
    // Dropping the minimum must not weaken the membership check.
    const { strapi } = harness(null, []);

    await expect(
      validateEntityTopPickCoupons(
        strapi,
        'api::store.store',
        { topPickCoupons: [{ id: 99, documentId: 'coupon-99' }] },
        'store-1',
      ),
    ).rejects.toThrow(/related to this store/);
  });
});
