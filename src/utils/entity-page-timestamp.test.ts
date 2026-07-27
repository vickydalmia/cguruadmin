import { describe, expect, it, vi } from 'vitest';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from './entity-page-timestamp';

describe('changesEntityOfferMembership', () => {
  it.each(['coupons', 'deals', 'topPickCoupons', 'orderedCoupons'])(
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

/**
 * A knex-like transaction stub. Callable, because that is exactly how the real
 * one is used — `trx('stores').where(...).update(...)`.
 */
const makeTrx = () => {
  const update = vi.fn(async () => 1);
  const where = vi.fn(() => ({ update }));
  const trx: any = vi.fn(() => ({ where }));
  trx.update = update;
  trx.where = where;
  return trx;
};

describe('touchEntityPageUpdatedAt', () => {
  it('touches the entity row without a recursive Document Service update', async () => {
    const trx = makeTrx();
    const documents = vi.fn();
    const now = new Date('2026-07-26T12:00:00.000Z');
    // `db.connection` is present and must stay UNUSED — using it is the
    // self-deadlock this signature exists to prevent.
    const connection = vi.fn();
    const strapi = { db: { connection }, documents } as any;

    await touchEntityPageUpdatedAt(
      strapi,
      trx,
      'api::store.store',
      { id: 42 },
      'store-1',
      now,
    );

    expect(trx).toHaveBeenCalledWith('stores');
    expect(trx.where).toHaveBeenCalledWith({ id: 42 });
    expect(trx.update).toHaveBeenCalledWith({ updated_at: now });
    expect(documents).not.toHaveBeenCalled();
    expect(connection).not.toHaveBeenCalled();
  });

  it('never issues the update on a pool connection', async () => {
    // THE REGRESSION GUARD. Running this on `strapi.db.connection` deadlocks
    // against the row lock the enclosing write transaction already holds: the
    // update waits for the lock, the transaction waits for this call, and the
    // save hangs forever with no timeout. The symptom is a hang, so nothing
    // else in the suite would catch it.
    const trx = makeTrx();
    const connection = vi.fn(() => {
      throw new Error('must not touch the entity row on a pool connection');
    });
    const strapi = { db: { connection }, documents: vi.fn() } as any;

    await touchEntityPageUpdatedAt(strapi, trx, 'api::bank.bank', { id: 7 }, 'bank-1');

    expect(connection).not.toHaveBeenCalled();
    expect(trx).toHaveBeenCalledWith('banks');
  });

  it('refuses to run without a transaction', async () => {
    // Fail loudly rather than fall back to a pool connection: a hang is far
    // harder to diagnose than a thrown error.
    const strapi = { db: { connection: vi.fn() }, documents: vi.fn() } as any;

    await expect(
      touchEntityPageUpdatedAt(strapi, undefined, 'api::store.store', { id: 1 }, 's'),
    ).rejects.toThrow(/requires the write transaction/);
  });

  it('resolves the numeric row when the write result omits id', async () => {
    const trx = makeTrx();
    const findOne = vi.fn(async () => ({ id: 73 }));
    const strapi = {
      db: { connection: vi.fn() },
      documents: vi.fn(() => ({ findOne })),
    } as any;

    await touchEntityPageUpdatedAt(
      strapi,
      trx,
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
