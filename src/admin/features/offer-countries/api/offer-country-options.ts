import type { useFetchClient } from '@strapi/strapi/admin';

import type { OfferCountryOption } from '../../../../constants/offer-countries';

/**
 * Data access for the Offer Countries multi-select on Coupon/Deal edit forms.
 *
 * The option list is the ENABLED Country Setup subset served by
 * GET /offer-countries/options (any authenticated admin) — the picker must
 * offer exactly what the server-side validator accepts, and both read the
 * same site configuration.
 */

/** Exactly the `get` that `useFetchClient` returns — see merchant-options.ts. */
type FetchClient = Pick<ReturnType<typeof useFetchClient>, 'get'>;

export async function fetchEnabledOfferCountries(
  client: FetchClient,
): Promise<OfferCountryOption[]> {
  const response = await client.get('/offer-countries/options');
  const value: any =
    (response as any)?.data?.data ?? (response as any)?.data ?? response;
  if (!Array.isArray(value) || value.some((row) => typeof row?.code !== 'string')) {
    throw new Error('Offer country options returned an unexpected response.');
  }
  return value as OfferCountryOption[];
}

// The stored field value is a csv of uppercase registry codes. Same token
// rule as the server's parseOfferCountryTokens so the round trip never drops
// a value the server would keep; canonical ordering is the server's job.
const OFFER_COUNTRY_TOKEN = /^[A-Z]{2,6}$/;

export function parseOfferCountriesValue(value: unknown): string[] {
  const tokens = String(value ?? '')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => OFFER_COUNTRY_TOKEN.test(token));
  return [...new Set(tokens)];
}

/** Null (not '') is what makes the column empty — see the input's onChange. */
export function serializeOfferCountriesValue(
  codes: readonly string[],
): string | null {
  const csv = parseOfferCountriesValue(codes.join(',')).join(',');
  return csv === '' ? null : csv;
}
