import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  purgeResponseCaches: vi.fn(),
  purgeEntityPopularSearchCatalog: vi.fn(),
  insertIsrOutboxEvent: vi.fn(async () => ({
    id: 'event-1',
    eventKey: 'key-1',
    payload: { paths: ['/amazon/'] },
  })),
}));

vi.mock('../middlewares/cache', () => ({
  purgeResponseCaches: mocks.purgeResponseCaches,
}));
vi.mock('../api/store/services/entity-popular-searches', () => ({
  purgeEntityPopularSearchCatalog: mocks.purgeEntityPopularSearchCatalog,
}));

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  insertIsrOutboxEvent: mocks.insertIsrOutboxEvent,
}));

import { enqueueStandaloneIsrEvent, startIsrOutbox } from './runtime';

const strapi = { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as any;

describe('startIsrOutbox', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires delivery credentials in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ISR_GATEWAY_URL', '');
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(() => startIsrOutbox(strapi)).toThrow(/are required/);
  });

  it('does not require delivery credentials on a dispatcher-disabled process', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ISR_OUTBOX_DISPATCHER_ENABLED', 'false');
    vi.stubEnv('ISR_GATEWAY_URL', '');
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(() => startIsrOutbox(strapi)).not.toThrow();
    expect(strapi.log.info).toHaveBeenCalledWith(
      expect.stringContaining('ISR_OUTBOX_DISPATCHER_ENABLED=false'),
    );
  });

  it('reports when the existing render-process cron role disables delivery', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CRON_ENABLED', 'false');
    vi.stubEnv('ISR_OUTBOX_DISPATCHER_ENABLED', '');
    vi.stubEnv('ISR_GATEWAY_URL', '');
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(() => startIsrOutbox(strapi)).not.toThrow();
    expect(strapi.log.info).toHaveBeenCalledWith(
      expect.stringContaining('CRON_ENABLED=false fallback'),
    );
  });

  it('rejects a weak production admin secret at boot', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ISR_GATEWAY_URL', 'http://gateway:3010');
    vi.stubEnv('ISR_ADMIN_SECRET', 'short');
    expect(() => startIsrOutbox(strapi)).toThrow(/at least 16 characters/);
  });

  it('disables delivery outside production instead of throwing', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ISR_GATEWAY_URL', '');
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(() => startIsrOutbox(strapi)).not.toThrow();
    expect(strapi.log.warn).toHaveBeenCalled();
  });
});

describe('enqueueStandaloneIsrEvent', () => {
  it('purges response caches after commit before ISR delivery is woken', async () => {
    let onCommit: (() => void) | undefined;
    const trx = vi.fn();
    const transaction = vi.fn(async (callback: any) => {
      const result = await callback({
        trx,
        onCommit: (callback: () => void) => {
          onCommit = callback;
        },
      });
      expect(mocks.purgeResponseCaches).not.toHaveBeenCalled();
      onCommit?.();
      return result;
    });
    const standaloneStrapi = { db: { transaction } } as any;

    await expect(
      enqueueStandaloneIsrEvent(standaloneStrapi, {
        reason: 'inactive curated offer relations cleaned',
        payload: { paths: ['/amazon/'] },
      }),
    ).resolves.toMatchObject({ id: 'event-1', eventKey: 'key-1' });

    expect(mocks.insertIsrOutboxEvent).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ payload: { paths: ['/amazon/'] } }),
    );
    expect(mocks.purgeResponseCaches).toHaveBeenCalledTimes(1);
    expect(mocks.purgeEntityPopularSearchCatalog).toHaveBeenCalledTimes(1);
  });
});
