import type { CountrySetup } from './types';

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
  return Object.fromEntries(
    Object.entries(form).filter(([key]) => key !== 'features' && key !== 'localization'),
  );
}
