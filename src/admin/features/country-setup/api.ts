import type {
  CountrySetup,
  SelectableLanguage,
  SelectableOfferCountry,
} from './types';

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

const DERIVED_PAYLOAD_KEYS = new Set([
  'features',
  'localization',
  'languages',
  'offerCountryOptions',
]);

export function countrySetupPayload(form: CountrySetup): Record<string, unknown> {
  // `features`, `localization`, `languages` and `offerCountryOptions` are
  // DERIVED payload keys the server rebuilds on every read; only the editable
  // fields go back (the editable half of offer countries is the
  // `offerCountries` csv, which passes through).
  return Object.fromEntries(
    Object.entries(form).filter(([key]) => !DERIVED_PAYLOAD_KEYS.has(key)),
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

export function unwrapOfferCountries(response: unknown): SelectableOfferCountry[] {
  const value: any = (response as any)?.data?.data ?? (response as any)?.data ?? response;
  if (!Array.isArray(value) || value.some((row) => typeof row?.code !== 'string')) {
    throw new Error('Country Setup returned an unexpected offer-country list.');
  }
  return value as SelectableOfferCountry[];
}

// The stored `offerCountries` column is a csv of uppercase registry codes;
// the picker works on the code list. Same token rule as the server's
// parseOfferCountryTokens so the round trip never drops a value the server
// would keep. Order is left to the server's canonicalisation on save.
const OFFER_COUNTRY_TOKEN = /^[A-Z]{2,6}$/;

export function parseOfferCountries(csv: unknown): string[] {
  const tokens = String(csv ?? '')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => OFFER_COUNTRY_TOKEN.test(token));
  return [...new Set(tokens)];
}

export function serializeOfferCountries(codes: readonly string[]): string {
  return parseOfferCountries(codes.join(',')).join(',');
}
