import { describe, expect, it } from 'vitest';

import {
  configuredPublicSiteDomain,
  configuredPublicSiteUrl,
  normalizePublicSiteUrl,
} from './public-site-url';

describe('public site runtime configuration', () => {
  it('normalizes a configured URL to its origin', () => {
    expect(normalizePublicSiteUrl(' https://www.example.com/path?q=1#x ')).toBe(
      'https://www.example.com',
    );
  });

  it('rejects missing, non-http and credential-bearing URLs', () => {
    expect(normalizePublicSiteUrl(undefined)).toBeNull();
    expect(normalizePublicSiteUrl('')).toBeNull();
    expect(normalizePublicSiteUrl('not-a-url')).toBeNull();
    expect(normalizePublicSiteUrl('ftp://example.com')).toBeNull();
    expect(normalizePublicSiteUrl('https://user:secret@example.com')).toBeNull();
  });

  it('reads only PUBLIC_SITE_URL from the running process environment', () => {
    expect(
      configuredPublicSiteUrl({ PUBLIC_SITE_URL: 'https://www.couponzguruusa.com/' }),
    ).toBe('https://www.couponzguruusa.com');
    expect(
      configuredPublicSiteUrl({
        STRAPI_ADMIN_PUBLIC_SITE_URL: 'https://wrong.example',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('derives the registrable domain for first-party link classification', () => {
    expect(
      configuredPublicSiteDomain({ PUBLIC_SITE_URL: 'https://cms.couponzguru.co.ke' }),
    ).toBe('couponzguru.co.ke');
  });
});
