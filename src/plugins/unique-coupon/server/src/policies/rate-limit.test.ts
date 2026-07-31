import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TRUSTED_IP = '10.10.0.7';

/**
 * TRUSTED_IPS is read once at module load in the shared middleware, so the env
 * has to be set before the policy (and the middleware it imports) is imported.
 */
async function loadPolicy(trustedIps?: string) {
  vi.resetModules();
  if (trustedIps === undefined) {
    delete process.env.RATE_LIMIT_TRUSTED_IPS;
  } else {
    process.env.RATE_LIMIT_TRUSTED_IPS = trustedIps;
  }
  return (await import('./rate-limit')).default;
}

const invokePolicy = (policy: Awaited<ReturnType<typeof loadPolicy>>, ctx: any) =>
  policy(ctx, {}, { strapi: {} as any });

function createCtx(
  ip: string,
  { socketAddress = ip }: { socketAddress?: string } = {},
) {
  return {
    request: { ip },
    req: { socket: { remoteAddress: socketAddress } },
    set: vi.fn(),
  } as any;
}

const originalTrustedIps = process.env.RATE_LIMIT_TRUSTED_IPS;

afterEach(() => {
  if (originalTrustedIps === undefined) {
    delete process.env.RATE_LIMIT_TRUSTED_IPS;
  } else {
    process.env.RATE_LIMIT_TRUSTED_IPS = originalTrustedIps;
  }
});

describe('unique-coupon redeem rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sits above the gateway limit so the Redis limiter is the binding control', async () => {
    // The gateway allows 10/IP/min. Below that, this per-process counter would
    // become the real limit: N Strapi instances would mean an effective N x
    // allowance, and shared-NAT visitors would collect 429s the interstitial
    // renders as "code currently unavailable".
    const policy = await loadPolicy();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(invokePolicy(policy, createCtx('203.0.113.5'))).toBe(true);
    }
  });

  it('eventually refuses a caller that bypassed the gateway', async () => {
    const policy = await loadPolicy();
    const ctx = createCtx('203.0.113.6');

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(invokePolicy(policy, createCtx('203.0.113.6'))).toBe(true);
    }

    expect(() => invokePolicy(policy, ctx)).toThrowError(
      expect.objectContaining({ name: 'RateLimitError' }),
    );
    expect(ctx.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('bypasses a trusted socket entirely', async () => {
    // Without this, a deployment relying on RATE_LIMIT_TRUSTED_IPS rather than
    // TRUST_PROXY puts every visitor in one bucket and the whole site shares a
    // single redemption allowance.
    const policy = await loadPolicy(TRUSTED_IP);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(
        invokePolicy(
          policy,
          createCtx('203.0.113.7', { socketAddress: TRUSTED_IP }),
        ),
      ).toBe(true);
    }
  });

  it('matches the trust on the socket, not on the spoofable resolved IP', async () => {
    const policy = await loadPolicy(TRUSTED_IP);

    // A public client claiming to be the VPC via X-Forwarded-For resolves to
    // the trusted IP but connects from its own socket.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(
        invokePolicy(
          policy,
          createCtx(TRUSTED_IP, { socketAddress: '203.0.113.8' }),
        ),
      ).toBe(true);
    }

    expect(() =>
      invokePolicy(
        policy,
        createCtx(TRUSTED_IP, { socketAddress: '203.0.113.8' }),
      ),
    ).toThrowError(
      expect.objectContaining({ name: 'RateLimitError' }),
    );
  });
});
