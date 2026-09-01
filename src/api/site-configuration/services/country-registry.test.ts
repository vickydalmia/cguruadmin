import { describe, expect, it } from 'vitest';

import {
  FEATURE_FIELDS,
  INDIA_DEFAULT_CONFIGURATION,
  SITE_CONFIGURATION_FIELDS,
  featureByPath,
  normalizeSiteConfiguration,
} from './country-registry';

describe('country registry', () => {
  it('normalizes identity codes while preserving the India compatibility defaults', () => {
    expect(normalizeSiteConfiguration({
      countryCode: ' us ',
      currencyCode: ' usd ',
      siteName: ' CouponzGuru USA ',
    })).toMatchObject({
      ...INDIA_DEFAULT_CONFIGURATION,
      countryCode: 'US',
      currencyCode: 'USD',
      siteName: 'CouponzGuru USA',
    });
  });

  it('owns fixed routes instead of accepting editor-authored paths', () => {
    expect(featureByPath('/privacy-policy/')?.key).toBe('privacyPolicy');
    expect(featureByPath('/stores/')?.key).toBe('stores');
    expect(featureByPath('/deal-of-the-day/')).toBeUndefined();
    expect(featureByPath('/editor-invented/')).toBeUndefined();
  });

  it('does not store campaign activation as Country Setup flags', () => {
    expect(FEATURE_FIELDS).not.toContain('dealOfTheDayEnabled');
    expect(FEATURE_FIELDS).not.toContain('independenceDaySaleEnabled');
    expect(SITE_CONFIGURATION_FIELDS).not.toContain('dealOfTheDayEnabled');
    expect(SITE_CONFIGURATION_FIELDS).not.toContain(
      'independenceDaySaleEnabled',
    );
  });
});
