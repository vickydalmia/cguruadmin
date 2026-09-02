/**
 * Offer Countries — the optional set of countries (or regions) a single
 * Coupon / Product Deal is valid in, shown as flag tags on the storefront
 * cards and offered as a Country filter on entity pages.
 *
 * Two layers, deliberately separate:
 *
 *   1. THIS master registry — every country/region the product knows how to
 *      render (display code + flag asset on the storefront). Fixed in code
 *      because each entry needs a bundled flag image; extending it is a
 *      deploy, exactly like adding a language prompt file.
 *   2. Country Setup's `offerCountries` csv — the subset of the registry a
 *      deployment actually offers its editors. India/USA leave it empty and
 *      the field, tags and filter never appear anywhere.
 *
 * Stored form on Coupon/Deal: a csv of registry CODES (`"AE,SA"`), one plain
 * string column via a custom field — the same seam as checkoutMerchant
 * (src/constants/checkout-merchant.ts explains why a custom field is the only
 * supported way to render a bespoke input in the main edit form). The option
 * list must be the DYNAMIC Country Setup subset, so a schema `enumeration`
 * cannot express it.
 *
 * Regions EXPAND for filtering (product decision, 2026-09-02): an offer
 * tagged GCC matches a filter for any enabled GCC member; GLOBAL and MENA
 * match every enabled country. The entity-page filter lists only real
 * countries. An offer with NO countries is valid everywhere and matches every
 * country filter.
 *
 * Imported by BOTH halves of the app (server pipeline and admin bundle),
 * which is why it lives in src/constants.
 */

/** Attribute name on both offer schemas AND the Country Setup csv column. */
export const OFFER_COUNTRIES_FIELD = 'offerCountries';

/**
 * Registered with no plugin on either side so both registries derive the same
 * `global::` uid — see CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME for the pairing
 * rule (schema.json `customField` must match this uid exactly or boot fails).
 */
export const OFFER_COUNTRIES_CUSTOM_FIELD_NAME = 'offer-countries';
export const OFFER_COUNTRIES_CUSTOM_FIELD_UID = `global::${OFFER_COUNTRIES_CUSTOM_FIELD_NAME}`;

/** Content types that carry the field. Both offer types, per the brief. */
export const OFFER_COUNTRIES_OFFER_UIDS = [
  'api::coupon.coupon',
  'api::deal.deal',
] as const;

export type OfferCountriesOfferUid = (typeof OFFER_COUNTRIES_OFFER_UIDS)[number];

export function isOfferCountriesOfferUid(
  uid: unknown,
): uid is OfferCountriesOfferUid {
  return OFFER_COUNTRIES_OFFER_UIDS.includes(uid as OfferCountriesOfferUid);
}

export type OfferCountryKind = 'country' | 'region';

export type OfferCountryDefinition = {
  /** The stored token: ISO 3166-1 alpha-2 for countries, a word for regions. */
  code: string;
  /** The short label rendered next to the flag (design spelling: KSA not SA). */
  displayCode: string;
  name: string;
  kind: OfferCountryKind;
  /**
   * Region expansion for filtering: the member country codes, or 'all' for
   * regions that match every enabled country. Absent on countries.
   */
  members?: readonly string[] | 'all';
};

/**
 * Registry order is display order — the tag pill and the filter list both
 * render selections in this order, so two editors tagging "KSA, UAE" and
 * "UAE, KSA" produce the same stored value and the same pill.
 */
export const OFFER_COUNTRY_REGISTRY: readonly OfferCountryDefinition[] = [
  { code: 'AE', displayCode: 'UAE', name: 'United Arab Emirates', kind: 'country' },
  { code: 'SA', displayCode: 'KSA', name: 'Saudi Arabia', kind: 'country' },
  { code: 'KW', displayCode: 'KW', name: 'Kuwait', kind: 'country' },
  { code: 'BH', displayCode: 'BHR', name: 'Bahrain', kind: 'country' },
  { code: 'OM', displayCode: 'OM', name: 'Oman', kind: 'country' },
  { code: 'QA', displayCode: 'QA', name: 'Qatar', kind: 'country' },
  { code: 'JO', displayCode: 'JO', name: 'Jordan', kind: 'country' },
  { code: 'TR', displayCode: 'TR', name: 'Türkiye', kind: 'country' },
  { code: 'EG', displayCode: 'EGY', name: 'Egypt', kind: 'country' },
  {
    code: 'GCC',
    displayCode: 'GCC',
    name: 'GCC',
    kind: 'region',
    members: ['AE', 'SA', 'KW', 'BH', 'OM', 'QA'],
  },
  { code: 'GLOBAL', displayCode: 'GLOBAL', name: 'Global', kind: 'region', members: 'all' },
  { code: 'MENA', displayCode: 'MENA', name: 'MENA', kind: 'region', members: 'all' },
] as const;

const BY_CODE = new Map(OFFER_COUNTRY_REGISTRY.map((def) => [def.code, def]));

export function offerCountryByCode(
  code: string,
): OfferCountryDefinition | undefined {
  return BY_CODE.get(code);
}

/**
 * 12 registry codes joined is 45 characters; the cap only stops a hand-crafted
 * API write from pushing an unbounded string into the column.
 */
export const OFFER_COUNTRIES_MAX_LENGTH = 128;

/**
 * Split a stored/submitted csv into uppercase tokens: trimmed, deduped,
 * empties dropped, UNKNOWN TOKENS KEPT — validation reports them by name
 * instead of silently discarding an editor's selection.
 */
export function parseOfferCountryTokens(value: unknown): string[] {
  const tokens = String(value ?? '')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(tokens)];
}

/**
 * Canonical stored csv: known codes only, deduped, in registry order. The
 * validators reject unknown tokens BEFORE storing, so for a valid write this
 * only fixes case, padding and ordering.
 */
export function canonicalOfferCountries(value: unknown): string {
  const tokens = new Set(parseOfferCountryTokens(value));
  return OFFER_COUNTRY_REGISTRY.filter((def) => tokens.has(def.code))
    .map((def) => def.code)
    .join(',');
}

/** One row of the derived option list served to the storefront and pickers. */
export type OfferCountryOption = {
  code: string;
  displayCode: string;
  name: string;
  kind: OfferCountryKind;
  /**
   * The enabled COUNTRY codes this option matches in the entity-page filter:
   * a country matches itself; GCC matches its enabled members; GLOBAL/MENA
   * match every enabled country. Already intersected with the enabled set so
   * the storefront never has to know region membership.
   */
  countries: string[];
};

/**
 * Derive the option list for one deployment from its Country Setup csv.
 * Unknown tokens (a registry entry removed after being stored) are dropped —
 * fail safe, never a broken filter.
 */
export function enabledOfferCountryOptions(csv: unknown): OfferCountryOption[] {
  const enabled = new Set(
    parseOfferCountryTokens(csv).filter((code) => BY_CODE.has(code)),
  );
  const enabledCountryCodes = OFFER_COUNTRY_REGISTRY.filter(
    (def) => def.kind === 'country' && enabled.has(def.code),
  ).map((def) => def.code);

  return OFFER_COUNTRY_REGISTRY.filter((def) => enabled.has(def.code)).map(
    (def) => ({
      code: def.code,
      displayCode: def.displayCode,
      name: def.name,
      kind: def.kind,
      countries:
        def.kind === 'country'
          ? [def.code]
          : def.members === 'all'
            ? [...enabledCountryCodes]
            : (def.members ?? []).filter((code) =>
                enabledCountryCodes.includes(code),
              ),
    }),
  );
}

/** True when the payload value means "no countries" rather than a bad value. */
export function isBlankOfferCountries(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  );
}
