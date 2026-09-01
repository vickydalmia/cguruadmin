import { describe, expect, it, vi } from 'vitest';

import { INDIA_DEFAULT_CONFIGURATION } from './country-registry';
import { validateSiteConfigurationForWrite } from './site-configuration';

describe('site configuration writes', () => {
  it('allows an incomplete feature to be enabled for authoring', async () => {
    const findFirst = vi.fn(async () => ({
      ...INDIA_DEFAULT_CONFIGURATION,
      countryCode: 'US',
      locale: 'en-US',
      currencyCode: 'USD',
      timezone: 'America/New_York',
      aboutEnabled: false,
    }));
    const documents = vi.fn(() => ({ findFirst }));

    const result = await validateSiteConfigurationForWrite(
      { documents } as any,
      { aboutEnabled: true },
    );

    expect(result.aboutEnabled).toBe(true);
    // Readiness is a public-live gate, not a Country Setup write gate. The
    // validator therefore has no reason to query the missing About singleton.
    expect(documents).toHaveBeenCalledTimes(1);
    expect(documents).toHaveBeenCalledWith(
      'api::site-configuration.site-configuration',
    );
  });
});
