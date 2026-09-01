import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isResolvableContentLocale,
  resolveContentLocale,
  selectableContentLocales,
  textDirectionFor,
  unicodeScriptPattern,
} from './resolve';

const AE = { countryCode: 'AE', countryName: 'United Arab Emirates' };
const IN = { countryCode: 'IN', countryName: 'India' };

describe('resolveContentLocale', () => {
  it('resolves Arabic with the hand-tuned prompt overrides', () => {
    expect(resolveContentLocale('ar', AE)).toEqual({
      code: 'ar',
      name: 'Arabic',
      nativeName: 'العربية',
      dir: 'rtl',
      ogLocale: 'ar_AE',
      script: 'Arab',
      countryCode: 'AE',
      countryName: 'United Arab Emirates',
      promptFile: 'ar.md',
      editorPromptFile: 'ar-editor.md',
      glossaryFile: 'ar.md',
    });
  });

  it('resolves languages without overrides from ICU data', () => {
    expect(resolveContentLocale('hi', IN)).toMatchObject({
      code: 'hi',
      name: 'Hindi',
      nativeName: 'हिन्दी',
      dir: 'ltr',
      ogLocale: 'hi_IN',
      script: 'Deva',
    });
    expect(resolveContentLocale('hi', IN)).not.toHaveProperty('promptFile');
    expect(resolveContentLocale('zh', AE)).toMatchObject({
      name: 'Chinese',
      script: 'Hans',
      ogLocale: 'zh_AE',
    });
    expect(resolveContentLocale('ja', AE)).toMatchObject({
      name: 'Japanese',
      nativeName: '日本語',
      script: 'Jpan',
    });
    expect(resolveContentLocale('id', AE)).toMatchObject({
      name: 'Indonesian',
      script: 'Latn',
      dir: 'ltr',
    });
  });

  it('canonicalises case and whitespace', () => {
    expect(resolveContentLocale(' AR ', AE)?.code).toBe('ar');
    expect(resolveContentLocale('Hi', { countryCode: 'in', countryName: ' India ' })).toMatchObject({
      ogLocale: 'hi_IN',
      countryCode: 'IN',
      countryName: 'India',
    });
  });

  it('never resolves the English source, unknown or non-bare codes', () => {
    expect(resolveContentLocale('en', AE)).toBeNull();
    expect(resolveContentLocale('zz', AE)).toBeNull();
    expect(resolveContentLocale('pt-br', AE)).toBeNull();
    expect(resolveContentLocale('fil', AE)).toBeNull();
    expect(resolveContentLocale('', AE)).toBeNull();
    expect(resolveContentLocale(undefined, AE)).toBeNull();
    expect(isResolvableContentLocale('en')).toBe(false);
    expect(isResolvableContentLocale('zz')).toBe(false);
    expect(isResolvableContentLocale('hi')).toBe(true);
    expect(isResolvableContentLocale('AR')).toBe(true);
  });
});

describe('selectableContentLocales', () => {
  it('offers every resolvable ISO 639-1 code except English, sorted by name', () => {
    const list = selectableContentLocales(AE);
    const codes = list.map((locale) => locale.code);
    expect(codes).not.toContain('en');
    expect(codes).toEqual(expect.arrayContaining(['ar', 'hi', 'zh', 'ja', 'id', 'ur']));
    expect(new Set(codes).size).toBe(codes.length);
    expect(list.length).toBeGreaterThan(150);
    const names = list.map((locale) => locale.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(list.every((locale) => locale.ogLocale.endsWith('_AE'))).toBe(true);
  });
});

describe('textDirectionFor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the direction from ICU', () => {
    expect(textDirectionFor('ar')).toBe('rtl');
    expect(textDirectionFor('he')).toBe('rtl');
    expect(textDirectionFor('hi')).toBe('ltr');
  });

  it('falls back to the static RTL set when neither textInfo API exists', () => {
    class BareLocale {
      constructor(public readonly tag: string) {}
    }
    vi.stubGlobal('Intl', { ...Intl, Locale: BareLocale });
    expect(textDirectionFor('ar')).toBe('rtl');
    expect(textDirectionFor('fa')).toBe('rtl');
    expect(textDirectionFor('hi')).toBe('ltr');
  });

  it('uses the Node 22 getter when getTextInfo() is absent', () => {
    class GetterLocale {
      constructor(public readonly tag: string) {}
      get textInfo() {
        return { direction: this.tag === 'hi' ? 'rtl' : 'ltr' };
      }
    }
    vi.stubGlobal('Intl', { ...Intl, Locale: GetterLocale });
    // Deliberately wrong data proves the getter (not the fallback set) won.
    expect(textDirectionFor('hi')).toBe('rtl');
    expect(textDirectionFor('ar')).toBe('ltr');
  });
});

describe('unicodeScriptPattern', () => {
  it('maps CLDR-only script codes onto Unicode scripts', () => {
    expect(unicodeScriptPattern('Arab')?.test('كوبون')).toBe(true);
    expect(unicodeScriptPattern('Arab')?.test('coupon')).toBe(false);
    expect(unicodeScriptPattern('Deva')?.test('कूपन')).toBe(true);
    expect(unicodeScriptPattern('Hans')?.test('优惠券')).toBe(true);
    expect(unicodeScriptPattern('Hant')?.test('優惠券')).toBe(true);
    expect(unicodeScriptPattern('Jpan')?.test('クーポン')).toBe(true);
    expect(unicodeScriptPattern('Jpan')?.test('くーぽん')).toBe(true);
    expect(unicodeScriptPattern('Kore')?.test('쿠폰')).toBe(true);
    expect(unicodeScriptPattern('Kore')?.test('coupon')).toBe(false);
  });

  it('returns null for Latin, unknown and unsupported scripts', () => {
    expect(unicodeScriptPattern('Latn')).toBeNull();
    expect(unicodeScriptPattern(null)).toBeNull();
    expect(unicodeScriptPattern('Zzzz')).toBeNull();
    expect(unicodeScriptPattern('Not A Script')).toBeNull();
  });
});
