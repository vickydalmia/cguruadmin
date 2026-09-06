import { describe, expect, it } from 'vitest';

import {
  parseTranslationLocales,
  serializeTranslationLocales,
  unwrapLanguages,
} from './api';

describe('translation locale csv helpers', () => {
  it('parses, trims, lowercases and dedupes the stored csv', () => {
    expect(parseTranslationLocales(' AR, hi ,ar,,HI ')).toEqual(['ar', 'hi']);
    expect(parseTranslationLocales('')).toEqual([]);
    expect(parseTranslationLocales(undefined)).toEqual([]);
    expect(parseTranslationLocales(null)).toEqual([]);
  });

  it('drops tokens the server normalizer would drop', () => {
    expect(parseTranslationLocales('ar,a,arabic,pt-br,x1')).toEqual(['ar', 'pt-br']);
  });

  it('serializes a code list back into the canonical csv', () => {
    expect(serializeTranslationLocales(['HI', 'ar', 'hi'])).toBe('hi,ar');
    expect(serializeTranslationLocales([])).toBe('');
  });

  it('round-trips without loss', () => {
    const csv = 'ar,hi,zh';
    expect(serializeTranslationLocales(parseTranslationLocales(csv))).toBe(csv);
    const codes = ['ar', 'hi'];
    expect(parseTranslationLocales(serializeTranslationLocales(codes))).toEqual(codes);
  });
});

describe('unwrapLanguages', () => {
  const rows = [
    { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl', script: 'Arab' },
  ];

  it('accepts the fetch-client envelope and the bare body', () => {
    expect(unwrapLanguages({ data: { data: rows } })).toEqual(rows);
    expect(unwrapLanguages({ data: rows })).toEqual(rows);
    expect(unwrapLanguages(rows)).toEqual(rows);
  });

  it('rejects anything that is not a list of coded rows', () => {
    expect(() => unwrapLanguages({ data: { siteName: 'x' } })).toThrow(
      /unexpected language list/,
    );
    expect(() => unwrapLanguages({ data: [{ name: 'Arabic' }] })).toThrow(
      /unexpected language list/,
    );
  });
});
