import { describe, expect, it } from 'vitest';
import { isValidCanonicalUrl } from '../../utils/changed-field-rules';

describe('shared SEO canonicalUrl validation', () => {
  it.each([
    '',
    '/',
    '/airport-tour-coupons/',
    '/company/about',
    'https://beta.couponzguru.com/airport-tour-coupons/',
    'https://www.couponzguru.com/',
  ])('accepts a URL-only canonical: %s', (value) => {
    expect(isValidCanonicalUrl(value)).toBe(true);
  });

  it.each([
    '<link rel="canonical" href="https://beta.couponzguru.com/airport-tour-coupons/" />',
    '//evil.example/path',
    'airport-tour-coupons',
    '/airport tour-coupons/',
    '/airport-tour-coupons/?campaign=test',
    '/airport-tour-coupons/#offers',
    'javascript:alert(1)',
  ])('rejects a non-URL canonical: %s', (value) => {
    expect(isValidCanonicalUrl(value)).toBe(false);
  });
});
