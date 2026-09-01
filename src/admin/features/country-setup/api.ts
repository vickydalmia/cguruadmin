import type { CountrySetup, SelectableLanguage } from './types';

export function unwrapCountrySetup(response: unknown): CountrySetup {
  const value: any = (response as any)?.data?.data ?? (response as any)?.data ?? response;
  if (!value || typeof value !== 'object' || typeof value.siteName !== 'string') {
    throw new Error('Country Setup returned an unexpected response.');
  }
  return value as CountrySetup;
}

export function countrySetupError(error: any): string {
  const problems = error?.response?.data?.error?.details?.problems;
  if (Array.isArray(problems) && problems.length > 0) return problems.join(' ');
  return error?.response?.data?.error?.message ?? error?.message ?? 'Country Setup could not be saved.';
}

export function countrySetupPayload(form: CountrySetup): Record<string, unknown> {
  // `features`, `localization` and `languages` are DERIVED payload keys the
  // server rebuilds on every read; only the editable fields go back.
  return Object.fromEntries(
    Object.entries(form).filter(
      ([key]) => key !== 'features' && key !== 'localization' && key !== 'languages',
    ),
  );
}

export function unwrapLanguages(response: unknown): SelectableLanguage[] {
  const value: any = (response as any)?.data?.data ?? (response as any)?.data ?? response;
  if (!Array.isArray(value) || value.some((row) => typeof row?.code !== 'string')) {
    throw new Error('Country Setup returned an unexpected language list.');
  }
  return value as SelectableLanguage[];
}

// The stored `translationLocales` column is a csv; the picker works on the
// code list. Same token rule as the server's normalizeTranslationLocales so
// the round trip never drops a value the server would keep.
const LOCALE_TOKEN = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

export function parseTranslationLocales(csv: unknown): string[] {
  const tokens = String(csv ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => LOCALE_TOKEN.test(token));
  return [...new Set(tokens)];
}

export function serializeTranslationLocales(codes: readonly string[]): string {
  return parseTranslationLocales(codes.join(',')).join(',');
}
