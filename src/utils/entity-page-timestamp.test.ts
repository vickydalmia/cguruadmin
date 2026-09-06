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
  it('touches every locale row of the document without a recursive Document Service update', async () => {
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
    // document_id addressing: the en row AND its locale twins all move, so
    // the public timestamp never goes stale on a translated page.
    expect(trx.where).toHaveBeenCalledWith({ document_id: 'store-1' });
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
    expect(trx.where).toHaveBeenCalledWith({ document_id: 'bank-1' });
  });

  it('refuses to run without a transaction', async () => {
    // Fail loudly rather than fall back to a pool connection: a hang is far
    // harder to diagnose than a thrown error.
    const strapi = { db: { connection: vi.fn() }, documents: vi.fn() } as any;

    await expect(
      touchEntityPageUpdatedAt(strapi, undefined, 'api::store.store', { id: 1 }, 's'),
    ).rejects.toThrow(/requires the write transaction/);
  });

  it('addresses by documentId even when the write result omits id', async () => {
    const trx = makeTrx();
    const documents = vi.fn();
    const strapi = {
      db: { connection: vi.fn() },
      documents,
    } as any;

    await touchEntityPageUpdatedAt(
      strapi,
      trx,
      'api::category.category',
      {},
      'category-1',
    );

    expect(documents).not.toHaveBeenCalled();
    expect(trx.where).toHaveBeenCalledWith({ document_id: 'category-1' });
  });

  it('falls back to the written row id when no documentId is known', async () => {
    const trx = makeTrx();
    const strapi = { db: { connection: vi.fn() }, documents: vi.fn() } as any;

    await touchEntityPageUpdatedAt(
      strapi,
      trx,
      'api::category.category',
      { id: 73 },
      undefined,
    );

    expect(trx.where).toHaveBeenCalledWith({ id: 73 });
  });
});
