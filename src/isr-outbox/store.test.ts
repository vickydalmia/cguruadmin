import { describe, expect, it, vi } from 'vitest';
import {
  IsrOutboxStore,
  insertIsrOutboxEvent,
  parseIsrOutboxPayload,
} from './store';
import type { IsrOutboxEvent } from './types';

describe('ISR outbox payload validation', () => {
  it('accepts the existing wire protocol', () => {
    expect(
      parseIsrOutboxPayload({
        paths: ['/amazon/', '/amazon-deals/'],
        optionalPaths: ['/amazon-deals/'],
        scopes: ['routes'],
        offerInvalidations: [
          { entityType: 'coupon', documentId: 'coupon-1' },
        ],
      }),
    ).toEqual({
      paths: ['/amazon/', '/amazon-deals/'],
      optionalPaths: ['/amazon-deals/'],
      scopes: ['routes'],
      offerInvalidations: [
        { entityType: 'coupon', documentId: 'coupon-1' },
      ],
    });
  });

  it.each([
    null,
    [],
    {},
    { all: false },
    { paths: [null] },
    {
      paths: ['/amazon/'],
      optionalPaths: ['/amazon-deals/'],
    },
    { offerInvalidations: [{ entityType: 'deal' }] },
  ])('rejects a structurally invalid durable payload: %j', (payload) => {
    expect(() => parseIsrOutboxPayload(payload)).toThrow();
  });
});

describe('ISR outbox lease ownership', () => {
  const event: IsrOutboxEvent = {
    id: '42',
    eventKey: 'event-42',
    lockToken: 'owner-token',
    payload: { all: true },
    reason: 'test',
    attemptCount: 0,
  };

  it('uses the lock token in the delivered compare-and-swap', async () => {
    const where = vi.fn().mockReturnThis();
    const update = vi.fn(async () => 0);
    const strapi = {
      db: { connection: vi.fn(() => ({ where, update })) },
    } as any;
    const store = new IsrOutboxStore(strapi, 120_000, 300_000);
    await expect(store.markDelivered(event)).resolves.toBe(false);
    expect(where).toHaveBeenCalledWith({
      id: '42',
      event_key: 'event-42',
      status: 'processing',
      lock_token: 'owner-token',
    });
  });

  it('keeps a failed stale owner from scheduling a retry', async () => {
    const where = vi.fn().mockReturnThis();
    const whereNot = vi.fn().mockReturnThis();
    const forUpdate = vi.fn().mockReturnThis();
    const first = vi.fn(async () => undefined);
    const update = vi.fn(async () => 0);
    const builder = { where, whereNot, forUpdate, first, update };
    const trx: any = vi.fn(() => builder);
    trx.raw = vi.fn(async () => undefined);
    const strapi = {
      db: {
        transaction: vi.fn(async (callback) => callback({ trx })),
      },
    } as any;
    const store = new IsrOutboxStore(strapi, 120_000, 300_000);
    await expect(store.scheduleRetry(event, 'timeout')).resolves.toMatchObject({
      owned: false,
      attemptCount: 1,
    });
  });
});

describe('ISR retry/pending coalescing', () => {
  it('merges a failed processing payload into the newer pending event', async () => {
    const rows: any[] = [
      {
        id: '42',
        event_key: 'translation-isr:ar',
        status: 'processing',
        lock_token: 'owner-token',
        payload: JSON.stringify({ localePrefix: '/ar', paths: ['/older/'] }),
      },
      {
        id: '43',
        event_key: 'translation-isr:ar',
        status: 'pending',
        lock_token: null,
        payload: JSON.stringify({ localePrefix: '/ar', paths: ['/newer/'] }),
      },
    ];
    const trx: any = (_table: string) => {
      let filters: Record<string, unknown> = {};
      let excluded: Record<string, unknown> = {};
      const matches = (row: any) =>
        Object.entries(filters).every(([key, value]) => row[key] === value) &&
        Object.entries(excluded).every(([key, value]) => row[key] !== value);
      const chain: any = {
        where(value: Record<string, unknown>) {
          filters = { ...filters, ...value };
          return chain;
        },
        whereNot(value: Record<string, unknown>) {
          excluded = { ...excluded, ...value };
          return chain;
        },
        forUpdate() {
          return chain;
        },
        async first() {
          return rows.find(matches);
        },
        async update(value: Record<string, unknown>) {
          const found = rows.find(matches);
          if (!found) return 0;
          Object.assign(found, value);
          return 1;
        },
      };
      return chain;
    };
    trx.raw = vi.fn(async () => undefined);
    const strapi = {
      db: { transaction: vi.fn(async (callback) => callback({ trx })) },
    } as any;
    const store = new IsrOutboxStore(strapi, 120_000, 300_000);
    const event: IsrOutboxEvent = {
      id: '42',
      eventKey: 'translation-isr:ar',
      lockToken: 'owner-token',
      payload: { localePrefix: '/ar', paths: ['/older/'] },
      reason: 'older',
      attemptCount: 0,
    };

    await expect(store.scheduleRetry(event, 'gateway timeout')).resolves.toMatchObject({
      owned: true,
      delayMs: 0,
    });

    expect(rows[0]).toMatchObject({
      status: 'delivered',
      lock_token: null,
    });
    expect(parseIsrOutboxPayload(rows[1].payload)).toEqual({
      localePrefix: '/ar',
      paths: ['/older/', '/newer/'],
    });
  });
});

describe('translation ISR coalescing', () => {
  it('keeps ten thousand pending writes in one bounded locale event', async () => {
    let row: any = null;
    let inserts = 0;
    let updates = 0;
    const transaction: any = (_table: string) => {
      let where: Record<string, unknown> = {};
      const chain: any = {
        where(value: Record<string, unknown>) {
          where = value;
          return chain;
        },
        forUpdate() {
          return chain;
        },
        async first() {
          return row && row.event_key === where.event_key && row.status === where.status
            ? { ...row }
            : undefined;
        },
        insert(value: Record<string, unknown>) {
          return {
            returning: async () => {
              inserts += 1;
              row = { id: '1', ...value };
              return [{ id: '1', event_key: value.event_key }];
            },
          };
        },
        async update(value: Record<string, unknown>) {
          updates += 1;
          Object.assign(row, value);
          return 1;
        },
      };
      return chain;
    };
    transaction.raw = vi.fn(async () => undefined);

    for (let index = 0; index < 10_000; index += 1) {
      await insertIsrOutboxEvent(transaction, {
        eventKey: 'translation-isr:ar',
        reason: 'translated row',
        payload: {
          localePrefix: '/ar',
          paths: [`/entity-${index % 10}/`],
        },
      });
    }

    expect(inserts).toBe(1);
    expect(updates).toBe(9_999);
    expect(parseIsrOutboxPayload(row.payload).paths).toHaveLength(10);
    expect(parseIsrOutboxPayload(row.payload).localePrefix).toBe('/ar');
  });
});
