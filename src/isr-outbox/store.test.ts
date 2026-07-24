import { describe, expect, it, vi } from 'vitest';
import {
  IsrOutboxStore,
  parseIsrOutboxPayload,
} from './store';
import type { IsrOutboxEvent } from './types';

describe('ISR outbox payload validation', () => {
  it('accepts the existing wire protocol', () => {
    expect(
      parseIsrOutboxPayload({
        paths: ['/amazon/'],
        scopes: ['routes'],
        offerInvalidations: [
          { entityType: 'coupon', documentId: 'coupon-1' },
        ],
      }),
    ).toEqual({
      paths: ['/amazon/'],
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
    const update = vi.fn(async () => 0);
    const strapi = {
      db: { connection: vi.fn(() => ({ where, update })) },
    } as any;
    const store = new IsrOutboxStore(strapi, 120_000, 300_000);
    await expect(store.scheduleRetry(event, 'timeout')).resolves.toMatchObject({
      owned: false,
      attemptCount: 1,
    });
  });
});
