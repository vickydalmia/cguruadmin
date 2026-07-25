import { describe, expect, it, vi } from 'vitest';
import {
  cleanupDeliveredEvents,
  deliveredRetentionCutoff,
  deliverOutboxEvent,
  dispatchOne,
  IsrOutboxDispatcher,
} from './dispatcher';
import type { IsrOutboxEvent } from './types';

const event: IsrOutboxEvent = {
  id: '42',
  eventKey: 'stable-key',
  lockToken: 'lease-1',
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

it('contains a failed dispatcher cycle and exposes it in status', async () => {
  const logged = vi.fn();
  const dispatcher = new IsrOutboxDispatcher(
    {
      log: {
        error: logged,
        warn: vi.fn(),
        info: vi.fn(),
      },
    } as any,
    {
      gatewayUrl: 'http://gateway.test',
      adminSecret: 'test-secret',
      pollMs: 2_000,
      batchSize: 1,
      requestTimeoutMs: 90_000,
      leaseMs: 120_000,
      maxBackoffMs: 300_000,
      alertAfterAttempts: 5,
      retentionDays: 30,
      maxPaths: 5_000,
      maxPayloadBytes: 900_000,
    },
  );
  (dispatcher as any).store = {
    deleteDeliveredBefore: vi.fn(async () => {
      throw new Error('database unavailable');
    }),
    claim: vi.fn(async () => {
      throw new Error('claim failed');
    }),
    statusSummary: vi.fn(async () => ({
      counts: {},
      oldestUndeliveredAt: null,
      expiredProcessing: 0,
    })),
  };
  await expect((dispatcher as any).runCycle()).resolves.toBeUndefined();
  await expect(dispatcher.status()).resolves.toMatchObject({
    ok: false,
    dispatcher: {
      lastError: 'claim failed',
      stalled: false,
    },
  });
  expect(logged).toHaveBeenCalled();
});

it('uses per-event progress to keep a long active drain healthy', async () => {
  const dispatcher = new IsrOutboxDispatcher(
    {
      log: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
      },
    } as any,
    {
      gatewayUrl: 'http://gateway.test',
      adminSecret: 'test-secret',
      pollMs: 2_000,
      batchSize: 2,
      requestTimeoutMs: 90_000,
      leaseMs: 120_000,
      maxBackoffMs: 300_000,
      alertAfterAttempts: 5,
      retentionDays: 30,
      maxPaths: 5_000,
      maxPayloadBytes: 900_000,
    },
    vi.fn(async () => new Response('{}', { status: 202 })) as any,
  );
  let claimCount = 0;
  (dispatcher as any).nextCleanupAt = Number.POSITIVE_INFINITY;
  (dispatcher as any).store = {
    claim: vi.fn(async () =>
      claimCount++ === 0 ? { state: 'event' as const, event } : null,
    ),
    markDelivered: vi.fn(async () => true),
    scheduleRetry: vi.fn(),
    statusSummary: vi.fn(async () => ({
      counts: {},
      oldestUndeliveredAt: null,
      expiredProcessing: 0,
    })),
  };
  (dispatcher as any).startedAt = Date.now() - 240_000;
  (dispatcher as any).lastCycleStartedAt = Date.now() - 180_000;
  (dispatcher as any).lastCycleCompletedAt = Date.now() - 200_000;
  (dispatcher as any).lastProgressAt = 0;

  await (dispatcher as any).drain();

  await expect(dispatcher.status()).resolves.toMatchObject({
    ok: true,
    dispatcher: {
      stalled: false,
      lastProgressAt: expect.any(Number),
    },
  });
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
      claim: vi.fn(async () => ({ state: 'event' as const, event })),
      markDelivered: vi.fn(async () => true),
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
      claim: vi.fn(async () => ({ state: 'event' as const, event })),
      markDelivered: vi.fn(),
      scheduleRetry: vi.fn(async (failedEvent: IsrOutboxEvent) => {
        expect(failedEvent.eventKey).toBe('stable-key');
        return { owned: true, attemptCount: 1, delayMs: 1_000 };
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

  it('does not overwrite a newer lease owner after delivery', async () => {
    const store = {
      claim: vi.fn(async () => ({ state: 'event' as const, event })),
      markDelivered: vi.fn(async () => false),
      scheduleRetry: vi.fn(),
    };
    const results: any[] = [];
    await dispatchOne(store, vi.fn(async () => undefined), (result) =>
      results.push(result),
    );
    expect(results).toEqual([
      { state: 'lease_lost', phase: 'delivered', event },
    ]);
    expect(store.scheduleRetry).not.toHaveBeenCalled();
  });

  it('reports a quarantined payload and continues the drain', async () => {
    const invalid = {
      state: 'invalid' as const,
      id: '43',
      eventKey: 'broken',
      error: 'payload must be an object',
    };
    const results: any[] = [];
    await expect(
      dispatchOne(
        {
          claim: vi.fn(async () => invalid),
          markDelivered: vi.fn(),
          scheduleRetry: vi.fn(),
        },
        vi.fn(),
        (result) => results.push(result),
      ),
    ).resolves.toBe(true);
    expect(results).toEqual([invalid]);
  });
});
