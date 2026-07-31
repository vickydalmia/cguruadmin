import { afterEach, describe, expect, it, vi } from 'vitest';
import { readIsrOutboxConfig, readOutboxPayloadBounds } from './config';

describe('ISR outbox configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses a request timeout with a safe lease margin', () => {
    vi.stubEnv('ISR_OUTBOX_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('ISR_OUTBOX_LEASE_MS', '');
    const config = readIsrOutboxConfig();
    expect(config.enabled).toBe(true);
    expect(config.requestTimeoutMs).toBe(90_000);
    expect(config.leaseMs).toBe(120_000);
    expect(config.maxPaths).toBe(5_000);
    expect(config.maxPayloadBytes).toBe(900_000);
  });

  it('rejects a lease that can expire during delivery', () => {
    vi.stubEnv('ISR_OUTBOX_REQUEST_TIMEOUT_MS', '60000');
    vi.stubEnv('ISR_OUTBOX_LEASE_MS', '89999');
    expect(() => readIsrOutboxConfig()).toThrow(/at least 30000ms/);
  });

  it('validates the gateway URL', () => {
    vi.stubEnv('ISR_GATEWAY_URL', 'redis://gateway');
    expect(() => readIsrOutboxConfig()).toThrow(/HTTP\(S\)/);
  });

  it('allows the dispatcher to be disabled explicitly', () => {
    vi.stubEnv('ISR_OUTBOX_DISPATCHER_ENABLED', 'false');
    expect(readIsrOutboxConfig().enabled).toBe(false);
  });

  it('inherits the existing single-process cron role when no override exists', () => {
    vi.stubEnv('CRON_ENABLED', 'false');
    vi.stubEnv('ISR_OUTBOX_DISPATCHER_ENABLED', '');
    expect(readIsrOutboxConfig().enabled).toBe(false);
  });

  it('allows delivery to be separated explicitly from the cron role', () => {
    vi.stubEnv('CRON_ENABLED', 'false');
    vi.stubEnv('ISR_OUTBOX_DISPATCHER_ENABLED', 'true');
    expect(readIsrOutboxConfig().enabled).toBe(true);
  });

  it('rejects ambiguous dispatcher switches', () => {
    vi.stubEnv('ISR_OUTBOX_DISPATCHER_ENABLED', 'off');
    expect(() => readIsrOutboxConfig()).toThrow(/must be true or false/);
  });

  // The production Docker image builds with NODE_ENV=production and runs the
  // test suite before `yarn build`, without any delivery credentials. Reading
  // configuration must never depend on the deploy environment being present.
  it('reads payload bounds under NODE_ENV=production without credentials', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ISR_GATEWAY_URL', '');
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(readOutboxPayloadBounds()).toEqual({
      maxPaths: 5_000,
      maxPayloadBytes: 900_000,
    });
    expect(() => readIsrOutboxConfig()).not.toThrow();
  });
});
