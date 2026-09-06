import { describe, expect, it } from 'vitest';

import {
  OFFER_COUNTRY_REGISTRY,
  canonicalOfferCountries,
  enabledOfferCountryOptions,
  isBlankOfferCountries,
  offerCountryByCode,
  parseOfferCountryTokens,
} from './offer-countries';

describe('OFFER_COUNTRY_REGISTRY', () => {
  it('has unique codes that satisfy the schema regex', () => {
    const codes = OFFER_COUNTRY_REGISTRY.map((def) => def.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2,6}$/);
  });

  it('only names country members that exist as country entries', () => {
    const countryCodes = new Set(
      OFFER_COUNTRY_REGISTRY.filter((def) => def.kind === 'country').map(
        (def) => def.code,
      ),
    );
    for (const def of OFFER_COUNTRY_REGISTRY) {
      if (def.kind === 'region' && def.members !== 'all') {
        for (const member of def.members ?? []) {
          expect(countryCodes.has(member)).toBe(true);
        }
      }
      if (def.kind === 'country') expect(def.members).toBeUndefined();
    }
  });
});

describe('parseOfferCountryTokens', () => {
  it('uppercases, trims, dedupes and keeps unknown tokens for the validators', () => {
    expect(parseOfferCountryTokens(' ae, sa ,AE,,xx ')).toEqual(['AE', 'SA', 'XX']);
    expect(parseOfferCountryTokens(null)).toEqual([]);
    expect(parseOfferCountryTokens('')).toEqual([]);
  });
});

describe('canonicalOfferCountries', () => {
  it('emits known codes in registry order, dropping unknowns', () => {
    expect(canonicalOfferCountries('sa,ae,gcc,xx')).toBe('AE,SA,GCC');
    expect(canonicalOfferCountries('GLOBAL, EG')).toBe('EG,GLOBAL');
    expect(canonicalOfferCountries('')).toBe('');
  });
});

describe('enabledOfferCountryOptions', () => {
  it('expands a country to itself', () => {
    const options = enabledOfferCountryOptions('AE,SA');
    expect(options.map((option) => option.code)).toEqual(['AE', 'SA']);
    expect(options[0]).toEqual({
      code: 'AE',
      displayCode: 'UAE',
      name: 'United Arab Emirates',
      kind: 'country',
      countries: ['AE'],
    });
  });

  it('intersects GCC members with the enabled countries', () => {
    const options = enabledOfferCountryOptions('AE,SA,JO,GCC');
    const gcc = options.find((option) => option.code === 'GCC');
    // JO is enabled but not a GCC member; KW/BH/OM/QA are members but not enabled.
    expect(gcc?.countries).toEqual(['AE', 'SA']);
  });

  it('expands GLOBAL and MENA to every enabled country', () => {
    const options = enabledOfferCountryOptions('AE,SA,EG,GLOBAL,MENA');
    for (const code of ['GLOBAL', 'MENA']) {
      const region = options.find((option) => option.code === code);
      expect(region?.countries).toEqual(['AE', 'SA', 'EG']);
    }
  });

  it('drops unknown tokens and returns [] for an empty csv', () => {
    expect(enabledOfferCountryOptions('XX,YY')).toEqual([]);
    expect(enabledOfferCountryOptions('')).toEqual([]);
    expect(enabledOfferCountryOptions(null)).toEqual([]);
  });
});

describe('offerCountryByCode / isBlankOfferCountries', () => {
  it('resolves codes and recognises blanks', () => {
    expect(offerCountryByCode('AE')?.displayCode).toBe('UAE');
    expect(offerCountryByCode('ZZ')).toBeUndefined();
    expect(isBlankOfferCountries(null)).toBe(true);
    expect(isBlankOfferCountries('  ')).toBe(true);
    expect(isBlankOfferCountries('AE')).toBe(false);
  });
});
