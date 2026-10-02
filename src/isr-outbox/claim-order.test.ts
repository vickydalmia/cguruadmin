import knexFactory, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IsrOutboxStore } from './store';

describe('outbox claim scheduling and repair', () => {
  let db: Knex;
  let store: IsrOutboxStore;
  beforeEach(async () => {
    db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('isr_outbox', (t) => {
      t.increments('id');
      for (const name of ['event_key', 'delivery_key', 'payload', 'reason', 'status', 'lock_token', 'last_error']) t.text(name);
      t.integer('attempt_count').defaultTo(0);
      for (const name of ['next_attempt_at', 'created_at', 'locked_at', 'invalid_at']) t.timestamp(name);
    });
    store = new IsrOutboxStore({ db: { connection: db, transaction: (fn: any) => db.transaction((trx) => fn({ trx })) } } as any, 360000, 300000);
  });
  afterEach(async () => { await db.destroy(); });

  async function insert(id: number, dueAgo: number, extra = {}) {
    await db('isr_outbox').insert({ id, event_key: `event-${id}`, delivery_key: `delivery-${id}`, payload: JSON.stringify({ paths: ['/festival-test/'] }), reason: 'test', status: 'pending', next_attempt_at: new Date(Date.now() - dueAgo), created_at: new Date(), ...extra });
  }

  it('serves a waiting update before an older ID whose retry became due later', async () => {
    await insert(1, 1000, { attempt_count: 7000 });
    await insert(2, 10000);
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '2' } });
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '1', attemptCount: 7000 } });
  });

  it('keeps older due retries progressing instead of starving them behind new writes', async () => {
    await insert(1, 10000, { attempt_count: 7000 });
    await insert(2, 1000);
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '1' } });
  });

  it('preserves FIFO when scheduled times are equal', async () => {
    const next_attempt_at = new Date(Date.now() - 10000);
    await insert(2, 0, { next_attempt_at });
    await insert(1, 0, { next_attempt_at });
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '1' } });
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '2' } });
  });

  it('does not steal active leases or deliver a retry before its due time', async () => {
    await insert(1, 10000, { status: 'processing', locked_at: new Date() });
    await insert(2, -10000);
    await insert(3, 20000, { status: 'processing', locked_at: new Date(Date.now() - 400000) });
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '3' } });
    expect(await store.claim()).toBeNull();
  });

  it('persists the bounded deletion repair with the lease without resetting retry history', async () => {
    await insert(1, 10000, { reason: 'api::coupon.coupon delete', attempt_count: 7000, last_error: 'gateway skipped 1 path(s): /coupon/123/', payload: JSON.stringify({ paths: ['/', '/coupon/123/'], scopes: ['routes'] }) });
    const before = await db('isr_outbox').first();
    expect(await store.claim()).toMatchObject({ state: 'event', event: { id: '1', eventKey: 'event-1', deliveryKey: 'delivery-1', attemptCount: 7000, payload: { optionalPaths: ['/coupon/123/'] } } });
    const after = await db('isr_outbox').first();
    expect(JSON.parse(after.payload).optionalPaths).toEqual(['/coupon/123/']);
    expect(after.next_attempt_at).toEqual(before.next_attempt_at);
    expect(after.attempt_count).toEqual(before.attempt_count);
    expect(after.status).toBe('processing');
    expect(after.lock_token).toBeTruthy();
  });
});
