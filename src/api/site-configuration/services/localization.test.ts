import { describe, expect, it } from 'vitest';

import { localizationPreview, validateLocalization } from './localization';

describe('country localization', () => {
  it('derives ISO and display currency values for India and the USA', () => {
    expect(localizationPreview('en-US', 'USD', 'America/New_York')).toMatchObject({
      currencyCode: 'USD',
      currencySymbol: '$',
      numberExample: '$1,234.56',
    });
    expect(localizationPreview('en-IN', 'INR', 'Asia/Kolkata')).toMatchObject({
      currencyCode: 'INR',
      currencySymbol: '₹',
      numberExample: '₹1,234.56',
    });
  });

  it('accepts reusable country currencies and rejects invented ISO codes', () => {
    for (const currencyCode of ['INR', 'USD', 'AED', 'SGD', 'MYR', 'PHP']) {
      expect(() =>
        validateLocalization({ locale: 'en-US', currencyCode, timezone: 'UTC' }),
      ).not.toThrow();
    }
    expect(() =>
      validateLocalization({ locale: 'en-US', currencyCode: 'ZZZ', timezone: 'UTC' }),
    ).toThrow(/valid ISO 4217/u);
  });

  it('rejects invalid locales and timezones', () => {
    expect(() =>
      validateLocalization({ locale: 'not_a_locale', currencyCode: 'USD', timezone: 'Mars/Base' }),
    ).toThrow();
  });
});
