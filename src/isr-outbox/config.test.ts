import { afterEach, describe, expect, it, vi } from 'vitest';
import { readIsrOutboxConfig } from './config';

describe('ISR outbox configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses a request timeout with a safe lease margin', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ISR_OUTBOX_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('ISR_OUTBOX_LEASE_MS', '');
    const config = readIsrOutboxConfig();
    expect(config.requestTimeoutMs).toBe(90_000);
    expect(config.leaseMs).toBe(120_000);
    expect(config.maxPaths).toBe(5_000);
    expect(config.maxPayloadBytes).toBe(900_000);
  });

  it('rejects a lease that can expire during delivery', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ISR_OUTBOX_REQUEST_TIMEOUT_MS', '60000');
    vi.stubEnv('ISR_OUTBOX_LEASE_MS', '89999');
    expect(() => readIsrOutboxConfig()).toThrow(/at least 30000ms/);
  });

  it('validates the gateway URL and production secret', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ISR_GATEWAY_URL', 'redis://gateway');
    vi.stubEnv('ISR_ADMIN_SECRET', 'short');
    expect(() => readIsrOutboxConfig()).toThrow(/HTTP\(S\)/);

    vi.stubEnv('ISR_GATEWAY_URL', 'http://gateway:3010');
    expect(() => readIsrOutboxConfig()).toThrow(/at least 16/);
  });
});
