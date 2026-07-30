// Shared, browser-safe tables for the offer text fields. This file is the
// single source of truth for the write validator (offer-field-validation.ts),
// the editor-facing hints in index.ts, AND the Offer benefits side panel
// (src/admin/components/OfferBenefitsPanel.tsx) — what is shown can never
// drift from what is enforced.
//
// Kept free of server-only imports on purpose: the admin panel bundles this
// file for the browser, where `@strapi/utils` (node:stream) cannot load.

// The offer badge is a short free-text label capped by word count.
export const WORD_LIMITS: Array<{ field: string; label: string; max: number }> = [
  { field: 'offerText', label: 'Offer text', max: 3 },
];

// The three benefit texts store ONLY an amount — a percent ("10%") or a
// currency amount ("₹100" / "Rs.100" / "$40"). The public API appends the
// suffix on the way out (see src/utils/offer-text.ts), so editors never type
// the wording and it can never be misspelled or duplicated.
export const BENEFIT_TEXT_FIELDS: Array<{
  field: string;
  label: string;
  suffix: string;
}> = [
  { field: 'cashbackText', label: 'Cashback text', suffix: 'Cashback' },
  { field: 'bankOfferText', label: 'Bank offer text', suffix: 'Bank OFF' },
  { field: 'prepaidText', label: 'Prepaid text', suffix: 'Prepaid OFF' },
];

export function benefitFieldHint(suffix: string): string {
  return `Amount only — e.g. 10% or ₹100. “${suffix}” is appended automatically on the site.`;
}

// "10%" / "19.2%" — a percent needs a number before the sign.
const PERCENT_AMOUNT = /^\d{1,3}(?:\.\d+)?\s*%$/;
// "₹100" / "Rs.100" / "Rs 2,000" / "INR 500" / "$40" — a currency marker then
// digits (commas allowed). No trailing words.
const CURRENCY_AMOUNT = /^(?:₹|rs\.?|inr|\$)\s*\d[\d,]*$/i;

/** True when the value is a bare amount: "10%", "₹100", "Rs.100", "$40". */
export function isBenefitAmount(value: string): boolean {
  const trimmed = value.trim();
  return PERCENT_AMOUNT.test(trimmed) || CURRENCY_AMOUNT.test(trimmed);
}

/**
 * Canonicalize an accepted amount for display: "10 %" → "10%",
 * "Rs. 2,000" / "INR 2000" → "₹2000", "$ 40" → "$40". Returns the input
 * unchanged when it is not a bare amount (legacy full-text values pass
 * through untouched).
 */
export function normalizeBenefitAmount(value: string): string {
  const trimmed = value.trim();
  const pct = trimmed.match(PERCENT_AMOUNT);
  if (pct) return trimmed.replace(/\s+/g, '');
  const cur = trimmed.match(/^(₹|rs\.?|inr|\$)\s*([\d,]+)$/i);
  if (cur) {
    const symbol = /\$/.test(cur[1]) ? '$' : '₹';
    return symbol + cur[2].replace(/[^\d]/g, '');
  }
  return trimmed;
}
