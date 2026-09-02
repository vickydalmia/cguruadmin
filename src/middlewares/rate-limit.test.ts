import { afterEach, describe, expect, it, vi } from 'vitest';

// TRUSTED_IPS and TRUST_PRIVATE_SOCKETS are read once at module load, exactly
// as a container does at boot — so every case imports a fresh copy.
async function loadWithEnv(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  return import('./rate-limit');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isTrustedSocket', () => {
  it('matches exact entries and dot-terminated prefixes from the allowlist', async () => {
    const { isTrustedSocket } = await loadWithEnv({
      RATE_LIMIT_TRUSTED_IPS: '10.139.0.6, 172.19.0.',
      RATE_LIMIT_TRUST_PRIVATE_SOCKETS: '',
    });
    expect(isTrustedSocket('10.139.0.6')).toBe(true);
    expect(isTrustedSocket('::ffff:10.139.0.6')).toBe(true);
    expect(isTrustedSocket('172.19.0.3')).toBe(true);
    expect(isTrustedSocket('10.139.0.60')).toBe(false);
    expect(isTrustedSocket('172.18.0.1')).toBe(false);
    expect(isTrustedSocket(undefined)).toBe(false);
  });

  it('trusts nothing by default', async () => {
    const { isTrustedSocket, hasTrustedIpsConfigured } = await loadWithEnv({
      RATE_LIMIT_TRUSTED_IPS: '',
      RATE_LIMIT_TRUST_PRIVATE_SOCKETS: '',
    });
    expect(hasTrustedIpsConfigured()).toBe(false);
    expect(isTrustedSocket('172.18.0.1')).toBe(false);
    expect(isTrustedSocket('127.0.0.1')).toBe(false);
  });

  it('trusts private sockets only when the render-plane flag is set', async () => {
    const { isTrustedSocket, hasTrustedIpsConfigured } = await loadWithEnv({
      RATE_LIMIT_TRUSTED_IPS: '',
      RATE_LIMIT_TRUST_PRIVATE_SOCKETS: 'true',
    });
    expect(hasTrustedIpsConfigured()).toBe(true);
    // Docker bridge gateway (single-server hairpin NAT source).
    expect(isTrustedSocket('172.18.0.1')).toBe(true);
    expect(isTrustedSocket('::ffff:172.18.0.1')).toBe(true);
    // VPC private IP (two-droplet source) and loopback.
    expect(isTrustedSocket('10.114.0.4')).toBe(true);
    expect(isTrustedSocket('127.0.0.1')).toBe(true);
    expect(isTrustedSocket('::1')).toBe(true);
    expect(isTrustedSocket('192.168.1.20')).toBe(true);
    // Public addresses stay untrusted, including near-miss ranges.
    expect(isTrustedSocket('172.15.0.1')).toBe(false);
    expect(isTrustedSocket('172.32.0.1')).toBe(false);
    expect(isTrustedSocket('8.8.8.8')).toBe(false);
    expect(isTrustedSocket('2001:db8::1')).toBe(false);
  });

  it('requires the exact string "true" to enable private-socket trust', async () => {
    const { isTrustedSocket } = await loadWithEnv({
      RATE_LIMIT_TRUSTED_IPS: '',
      RATE_LIMIT_TRUST_PRIVATE_SOCKETS: '1',
    });
    expect(isTrustedSocket('172.18.0.1')).toBe(false);
  });
});
