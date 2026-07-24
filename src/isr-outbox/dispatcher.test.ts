import { describe, expect, it, vi } from 'vitest';
import {
  cleanupDeliveredEvents,
  deliveredRetentionCutoff,
  deliverOutboxEvent,
  dispatchOne,
} from './dispatcher';
import type { IsrOutboxEvent } from './types';

const event: IsrOutboxEvent = {
  id: '42',
  eventKey: 'stable-key',
  payload: { paths: ['/amazon/'] },
  reason: 'coupon update',
  attemptCount: 0,
};

it('computes the delivered-event retention cutoff in UTC milliseconds', () => {
  const now = Date.parse('2026-07-24T12:00:00.000Z');
  expect(deliveredRetentionCutoff(now, 30).toISOString()).toBe(
    '2026-06-24T12:00:00.000Z',
  );
});

it('cleans delivered rows before the retention cutoff', async () => {
  const deleteDeliveredBefore = vi.fn(async () => 17);
  const now = Date.parse('2026-07-24T12:00:00.000Z');
  await expect(
    cleanupDeliveredEvents({ deleteDeliveredBefore }, now, 30),
  ).resolves.toEqual({ state: 'cleaned', deleted: 17 });
  expect(deleteDeliveredBefore).toHaveBeenCalledWith(
    new Date('2026-06-24T12:00:00.000Z'),
  );
});

it('contains cleanup failures so delivery can continue', async () => {
  const failure = new Error('cleanup unavailable');
  await expect(
    cleanupDeliveredEvents(
      {
        deleteDeliveredBefore: vi.fn(async () => {
          throw failure;
        }),
      },
      Date.now(),
      30,
    ),
  ).resolves.toEqual({ state: 'failed', error: failure });
});

describe('deliverOutboxEvent', () => {
  it('sends the stable event key and accepts a 202 response', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    await deliverOutboxEvent(
      event,
      {
        gatewayUrl: 'http://gateway.test',
        adminSecret: 'secret',
        requestTimeoutMs: 5_000,
      },
      fetchImpl as any,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://gateway.test/revalidate');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer secret',
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      eventKey: 'stable-key',
      paths: ['/amazon/'],
    });
  });

  it('throws a useful error for a rejected delivery', async () => {
    await expect(
      deliverOutboxEvent(
        event,
        {
          gatewayUrl: 'http://gateway.test',
          adminSecret: 'secret',
          requestTimeoutMs: 5_000,
        },
        async () => new Response('redis unavailable', { status: 503 }),
      ),
    ).rejects.toThrow('gateway returned 503: redis unavailable');
  });
});

describe('dispatchOne', () => {
  it('marks a successfully delivered event complete', async () => {
    const store = {
      claim: vi.fn(async () => event),
      markDelivered: vi.fn(async () => undefined),
      scheduleRetry: vi.fn(),
    };
    const results: any[] = [];

    await expect(
      dispatchOne(store, vi.fn(async () => undefined), (result) =>
        results.push(result),
      ),
    ).resolves.toBe(true);
    expect(store.markDelivered).toHaveBeenCalledWith(event);
    expect(store.scheduleRetry).not.toHaveBeenCalled();
    expect(results[0].state).toBe('delivered');
  });

  it('schedules a retry without changing the event key', async () => {
    const store = {
      claim: vi.fn(async () => event),
      markDelivered: vi.fn(),
      scheduleRetry: vi.fn(async (failedEvent: IsrOutboxEvent) => {
        expect(failedEvent.eventKey).toBe('stable-key');
        return { attemptCount: 1, delayMs: 1_000 };
      }),
    };
    const results: any[] = [];

    await expect(
      dispatchOne(
        store,
        vi.fn(async () => {
          throw new Error('network down');
        }),
        (result) => results.push(result),
      ),
    ).resolves.toBe(true);
    expect(store.markDelivered).not.toHaveBeenCalled();
    expect(store.scheduleRetry).toHaveBeenCalledWith(event, 'network down');
    expect(results[0]).toMatchObject({
      state: 'retry',
      event,
      attemptCount: 1,
      delayMs: 1_000,
    });
  });

  it('does nothing when no event can be claimed', async () => {
    const store = {
      claim: vi.fn(async () => null),
      markDelivered: vi.fn(),
      scheduleRetry: vi.fn(),
    };
    await expect(
      dispatchOne(store, vi.fn(async () => undefined)),
    ).resolves.toBe(false);
  });
});
