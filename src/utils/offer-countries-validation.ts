import type { Core } from '@strapi/strapi';

import { cachedSiteConfiguration } from '../api/site-configuration/services/cached-configuration';
import {
  OFFER_COUNTRIES_FIELD,
  OFFER_COUNTRIES_MAX_LENGTH,
  canonicalOfferCountries,
  isBlankOfferCountries,
  isOfferCountriesOfferUid,
  offerCountryByCode,
  parseOfferCountryTokens,
} from '../constants/offer-countries';
import { toValidationError, type Problem } from './write-validation/problems';

/**
 * Write validation for `offerCountries` on Coupon/Deal — a custom STRING csv
 * (src/constants/offer-countries.ts), so nothing at the schema level checks
 * its tokens.
 *
 * Two rules:
 *   1. Every token must be a registry code — a typo'd API write must fail,
 *      not store a tag the storefront cannot render.
 *   2. Every token must be ENABLED in Country Setup, so an editor can only
 *      tag what this deployment offers. Checked against the 60s-memoized
 *      configuration — the Country Setup save path invalidates it, so the
 *      admin picker and this validator agree in-process.
 *
 * DISABLING a country in Country Setup later does NOT touch stored tags
 * (unlike clearDeletedCheckoutMerchant): the storefront drops codes missing
 * from its enabled option list at render time, so a disabled tag simply stops
 * showing, and re-enabling the country brings it back with no data loss.
 *
 * Grandfathering matches the rest of src/utils: only a payload that TOUCHES
 * the field is judged (strict re-arms the check on the effective record), so
 * an unrelated edit to an offer whose tag was disabled long ago never blocks.
 */

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export async function validateOfferCountriesForWrite(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: any,
  documentId?: string,
  strict: boolean = false,
): Promise<void> {
  if (!isOfferCountriesOfferUid(uid)) return;
  if (!data || typeof data !== 'object') return;
  if (!['create', 'update', 'clone'].includes(action)) return;

  const touched = hasOwn(data, OFFER_COUNTRIES_FIELD);
  if (!touched && !strict) return;

  let value: unknown = touched
    ? Reflect.get(data, OFFER_COUNTRIES_FIELD)
    : undefined;

  if (!touched && documentId) {
    try {
      const stored: any = await strapi.documents(uid as any).findOne({
        documentId,
        fields: [OFFER_COUNTRIES_FIELD] as any,
      });
      value = stored?.[OFFER_COUNTRIES_FIELD];
    } catch {
      return;
    }
  }

  if (isBlankOfferCountries(value)) {
    // A touched blank means "no countries" — store NULL, not the raw
    // spelling, so downstream equality/emptiness checks never meet a padded
    // empty string.
    if (touched && value !== null && value !== undefined) {
      Reflect.set(data, OFFER_COUNTRIES_FIELD, null);
    }
    return;
  }

  const problems: Problem[] = [];
  const path = [OFFER_COUNTRIES_FIELD];

  if (typeof value !== 'string' || value.length > OFFER_COUNTRIES_MAX_LENGTH) {
    problems.push({
      path,
      message:
        `Offer countries must be a comma-separated list of country codes of ` +
        `at most ${OFFER_COUNTRIES_MAX_LENGTH} characters. Re-pick the ` +
        `countries from the dropdown.`,
    });
    throw toValidationError(problems);
  }

  const tokens = parseOfferCountryTokens(value);

  const unknown = tokens.filter((code) => !offerCountryByCode(code));
  if (unknown.length > 0) {
    problems.push({
      path,
      message:
        `Unknown offer country code(s): ${unknown.join(', ')}. Re-pick the ` +
        `countries from the dropdown.`,
    });
    throw toValidationError(problems);
  }

  const config = await cachedSiteConfiguration(strapi);
  const enabled = new Set(parseOfferCountryTokens(config.offerCountries));
  const disabled = tokens.filter((code) => !enabled.has(code));
  if (disabled.length > 0) {
    problems.push({
      path,
      message:
        `Offer country code(s) not enabled in Country Setup: ` +
        `${disabled.join(', ')}. Enable them under Settings → Country Setup, ` +
        `or remove them from this offer.`,
    });
    throw toValidationError(problems);
  }

  // Canonicalize what gets STORED (case, padding, duplicate and ordering
  // differences), so equal selections always compare equal downstream. Only a
  // payload-carried value is rewritten; the strict fallback read of a stored
  // value has nothing to fix in this write.
  if (touched) {
    const canonical = canonicalOfferCountries(value);
    if (value !== canonical) {
      Reflect.set(data, OFFER_COUNTRIES_FIELD, canonical);
    }
  }
}
