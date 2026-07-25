import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIsrOutbox } from './runtime';

const strapi = { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as any;

describe('startIsrOutbox', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires delivery credentials in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ISR_GATEWAY_URL', '');
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(() => startIsrOutbox(strapi)).toThrow(/are required/);
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
