import { describe, expect, it, vi } from 'vitest';
import { validateEntityOrderedCoupons } from './entity-ordered-coupon-validation';

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

describe('entity Ordered Coupon selection rules', () => {
  it.each([
    ['api::store.store', 'stores'],
    ['api::brand.brand', 'brands'],
    ['api::category.category', 'categories'],
    ['api::bank.bank', 'banks'],
  ] as const)(
    'accepts ten live entity-scoped Coupons for %s',
    async (uid, relationField) => {
      const selected = Array.from({ length: 10 }, (_, index) => ({
        id: index + 1,
        documentId: `coupon-${index + 1}`,
      }));
      const { strapi, findMany } = harness(null, selected);

      await expect(
        validateEntityOrderedCoupons(
          strapi,
          uid,
          { orderedCoupons: selected },
          'entity-1',
        ),
      ).resolves.toBeUndefined();

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            $and: expect.arrayContaining([
              { [relationField]: { documentId: 'entity-1' } },
            ]),
          }),
          limit: 10,
        }),
      );
    },
  );

  it('rejects an eleventh Ordered Coupon', async () => {
    const { strapi, findMany } = harness();

    await expect(
      validateEntityOrderedCoupons(
        strapi,
        'api::store.store',
        {
          orderedCoupons: Array.from({ length: 11 }, (_, id) => ({
            id: id + 1,
          })),
        },
        'store-1',
      ),
    ).rejects.toThrow(/at most 10 Coupons/);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('allows an empty selection so the whole list falls back to newest-first', async () => {
    const { strapi, findMany } = harness();

    await expect(
      validateEntityOrderedCoupons(
        strapi,
        'api::category.category',
        { orderedCoupons: [] },
        'category-1',
      ),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('resolves connect/disconnect patches against the stored selection', async () => {
    const current = {
      orderedCoupons: Array.from({ length: 10 }, (_, index) => ({
        id: index + 1,
        documentId: `coupon-${index + 1}`,
      })),
      topPickCoupons: [],
    };
    const { strapi } = harness(current);

    await expect(
      validateEntityOrderedCoupons(
        strapi,
        'api::brand.brand',
        {
          orderedCoupons: {
            connect: [{ id: 11, documentId: 'coupon-11' }],
            disconnect: [],
          },
        },
        'brand-1',
      ),
    ).rejects.toThrow(/at most 10 Coupons/);
  });

  it('allows a Coupon in both Ordered Coupons and Top Picks', async () => {
    // Top Picks 3-4 are expiry buffers, invisible until an earlier pick dies,
    // so they are legitimately orderable in the main list meanwhile. Only the
    // two DISPLAYED picks must stay out — a positional rule this validator
    // cannot evaluate, so the cron repairs it instead (see
    // removeDisplayedTopPicksFromOrdered).
    const selected = [{ id: 1, documentId: 'coupon-1' }];
    const { strapi } = harness(
      { orderedCoupons: [], topPickCoupons: selected },
      selected,
    );

    await expect(
      validateEntityOrderedCoupons(
        strapi,
        'api::store.store',
        { orderedCoupons: selected },
        'store-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('ignores a write that does not touch Ordered Coupons', async () => {
    // It used to run for Top-Picks-only writes purely to catch the overlap.
    // Now that would only let an unrelated Top Pick edit be rejected for a
    // pre-existing Ordered Coupons problem it did not cause.
    const { strapi, findOne, findMany } = harness({
      orderedCoupons: Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        documentId: `coupon-${index + 1}`,
      })),
      topPickCoupons: [],
    });

    await expect(
      validateEntityOrderedCoupons(
        strapi,
        'api::bank.bank',
        { topPickCoupons: [{ id: 1, documentId: 'coupon-1' }] },
        'bank-1',
      ),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects an unavailable or unrelated Coupon', async () => {
    const selected = [
      { id: 1, documentId: 'coupon-1' },
      { id: 2, documentId: 'coupon-2' },
    ];
    const { strapi } = harness(null, [selected[0]]);

    await expect(
      validateEntityOrderedCoupons(
        strapi,
        'api::store.store',
        { orderedCoupons: selected },
        'store-1',
      ),
    ).rejects.toThrow(/related to this store/);
  });

  it('skips unrelated entity updates', async () => {
    const { strapi, findOne, findMany } = harness();

    await validateEntityOrderedCoupons(
      strapi,
      'api::store.store',
      { shortDescription: 'Updated' },
      'store-1',
    );

    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
