import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateOfferCountriesForWrite } from './offer-countries-validation';
import { cachedSiteConfiguration } from '../api/site-configuration/services/cached-configuration';

vi.mock('../api/site-configuration/services/cached-configuration', () => ({
  cachedSiteConfiguration: vi.fn(),
}));

const COUPON = 'api::coupon.coupon';
const DEAL = 'api::deal.deal';

const configWith = (offerCountries: string) => {
  vi.mocked(cachedSiteConfiguration).mockResolvedValue({
    offerCountries,
  } as any);
};

/** A strapi double whose document findOne returns `stored` for any lookup. */
const strapiWith = (stored: Record<string, unknown> | null = null) =>
  ({
    documents: () => ({ findOne: async () => stored }),
  }) as any;

beforeEach(() => {
  vi.mocked(cachedSiteConfiguration).mockReset();
  configWith('AE,SA,KW,GCC,GLOBAL');
});

describe('validateOfferCountriesForWrite', () => {
  it('is a no-op for content types without the field', async () => {
    await expect(
      validateOfferCountriesForWrite(strapiWith(), 'api::store.store', 'update', {
        offerCountries: 'XX',
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the payload does not touch the field', async () => {
    await expect(
      validateOfferCountriesForWrite(strapiWith(), COUPON, 'update', {
        title: 'New title',
      }),
    ).resolves.toBeUndefined();
    expect(cachedSiteConfiguration).not.toHaveBeenCalled();
  });

  it('accepts enabled codes and canonicalises what is stored', async () => {
    const data: any = { offerCountries: ' sa , ae ,sa' };
    await expect(
      validateOfferCountriesForWrite(strapiWith(), COUPON, 'create', data),
    ).resolves.toBeUndefined();
    // Registry order, uppercase, deduped.
    expect(data.offerCountries).toBe('AE,SA');
  });

  it('accepts regions that are enabled', async () => {
    const data: any = { offerCountries: 'GCC,GLOBAL' };
    await expect(
      validateOfferCountriesForWrite(strapiWith(), DEAL, 'create', data),
    ).resolves.toBeUndefined();
    expect(data.offerCountries).toBe('GCC,GLOBAL');
  });

  it('normalises a touched blank to null', async () => {
    for (const value of ['', '   ']) {
      const data: any = { offerCountries: value };
      await expect(
        validateOfferCountriesForWrite(strapiWith(), COUPON, 'update', data),
      ).resolves.toBeUndefined();
      expect(data.offerCountries).toBeNull();
    }
  });

  it('rejects unknown codes by name', async () => {
    await expect(
      validateOfferCountriesForWrite(strapiWith(), COUPON, 'update', {
        offerCountries: 'AE,XX',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('rejects registry codes that are not enabled in Country Setup', async () => {
    configWith('AE,SA');
    await expect(
      validateOfferCountriesForWrite(strapiWith(), COUPON, 'update', {
        offerCountries: 'AE,EG',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('rejects non-string and oversized values', async () => {
    for (const value of [42, 'A'.repeat(200)]) {
      await expect(
        validateOfferCountriesForWrite(strapiWith(), DEAL, 'create', {
          offerCountries: value,
        }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    }
  });

  it('strict mode judges the stored value without rewriting it', async () => {
    configWith('AE');
    const data: any = { title: 'Edit' };
    await expect(
      validateOfferCountriesForWrite(
        strapiWith({ offerCountries: 'AE,SA' }),
        COUPON,
        'update',
        data,
        'doc1',
        true,
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(data.offerCountries).toBeUndefined();
  });

  it('strict mode passes a stored value that is still enabled', async () => {
    await expect(
      validateOfferCountriesForWrite(
        strapiWith({ offerCountries: 'AE,GCC' }),
        COUPON,
        'update',
        { title: 'Edit' },
        'doc1',
        true,
      ),
    ).resolves.toBeUndefined();
  });
});
