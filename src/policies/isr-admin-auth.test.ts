import { afterEach, describe, expect, it, vi } from 'vitest';
import isrAdminAuth from './isr-admin-auth';

const context = (authorization?: string) => ({
  get: vi.fn(() => authorization ?? ''),
});

describe('ISR admin authorization policy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed without a configured secret', () => {
    vi.stubEnv('ISR_ADMIN_SECRET', '');
    expect(
      isrAdminAuth(context(), {}, { strapi: { log: { error: vi.fn() } } }),
    ).toBe(false);
  });

  it('accepts only the exact bearer value', () => {
    vi.stubEnv('ISR_ADMIN_SECRET', 'test-secret');
    expect(
      isrAdminAuth(context('Bearer test-secret'), {}, { strapi: {} }),
    ).toBe(true);
    expect(
      isrAdminAuth(context('Bearer wrong'), {}, { strapi: {} }),
    ).toBe(false);
  });
});
