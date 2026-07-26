import { describe, expect, it, vi } from 'vitest';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from './entity-page-timestamp';

describe('changesEntityOfferMembership', () => {
  it.each(['coupons', 'deals', 'topPickCoupons'])(
    'detects an entity %s relation write',
    (field) => {
      expect(
        changesEntityOfferMembership('api::store.store', {
          [field]: { connect: [{ documentId: 'offer-1' }] },
        }),
      ).toBe(true);
    },
  );

  it('ignores ordinary entity fields and non-entity documents', () => {
    expect(
      changesEntityOfferMembership('api::store.store', { name: 'Amazon' }),
    ).toBe(false);
    expect(
      changesEntityOfferMembership('api::coupon.coupon', { stores: [] }),
    ).toBe(false);
  });
});

describe('touchEntityPageUpdatedAt', () => {
  it('touches the entity row without a recursive Document Service update', async () => {
    const update = vi.fn(async () => 1);
    const where = vi.fn(() => ({ update }));
    const connection = vi.fn(() => ({ where }));
    const documents = vi.fn();
    const now = new Date('2026-07-26T12:00:00.000Z');
    const strapi = { db: { connection }, documents } as any;

    await touchEntityPageUpdatedAt(
      strapi,
      'api::store.store',
      { id: 42 },
      'store-1',
      now,
    );

    expect(connection).toHaveBeenCalledWith('stores');
    expect(where).toHaveBeenCalledWith({ id: 42 });
    expect(update).toHaveBeenCalledWith({ updated_at: now });
    expect(documents).not.toHaveBeenCalled();
  });

  it('resolves the numeric row when the write result omits id', async () => {
    const update = vi.fn(async () => 1);
    const connection = vi.fn(() => ({
      where: vi.fn(() => ({ update })),
    }));
    const findOne = vi.fn(async () => ({ id: 73 }));
    const strapi = {
      db: { connection },
      documents: vi.fn(() => ({ findOne })),
    } as any;

    await touchEntityPageUpdatedAt(
      strapi,
      'api::category.category',
      {},
      'category-1',
    );

    expect(findOne).toHaveBeenCalledWith({
      documentId: 'category-1',
      fields: ['documentId'],
    });
  });
});
