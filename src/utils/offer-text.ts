// `offerText` is stored as a short text string ("EXTRA 18% OFF") for easy admin
// editing, but the offer cards render it as separate words — a small qualifier,
// a big value, and "OFF". So the public API splits it into an array of words on
// the way out.
//
// The three benefit texts (`cashbackText`/`bankOfferText`/`prepaidText`) are
// stored as a BARE AMOUNT ("10%", "₹100" — enforced by
// offer-field-validation.ts) and decorated here on the way out with their
// wording: "10%" → "10% Cashback" / "₹100 Bank OFF" / "5% Prepaid OFF". The
// admin always reads/edits the raw stored amount — this transform runs only in
// the public custom controllers.

import {
  BENEFIT_TEXT_FIELDS,
  isBenefitAmount,
  normalizeBenefitAmount,
} from './offer-word-limits';
import { buildDealComputedContent } from './deal-computed-content';

/** Split a stored offerText string ("EXTRA 18% OFF") into its render words. */
export function splitOfferWords(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

const BENEFIT_SUFFIX: Record<string, string> = Object.fromEntries(
  BENEFIT_TEXT_FIELDS.map(({ field, suffix }) => [field, suffix]),
);

/**
 * "10%" → "10% Cashback"; "Rs. 2,000" → "₹2000 Bank OFF". A value that is not
 * a bare amount (legacy full-text rows like "15% Cashback" migrated before the
 * amount-only rule, kept by the validator's grandfather) passes through
 * unchanged — appending would double the wording.
 */
export function formatBenefitText(value: string, suffix: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (!isBenefitAmount(trimmed)) return trimmed;
  return `${normalizeBenefitAmount(trimmed)} ${suffix}`;
}

// A node carrying any of the Deal pricing scalars is a Deal payload — no other
// public content type exposes these keys.
const DEAL_PRICE_KEYS = ['salePrice', 'mrp', 'discount'];

/**
 * Recursively transform every offer text field in an API response: `offerText`
 * strings become arrays of words (so a coupon/deal card can render each word in
 * its own slot), each benefit text gains its wording suffix, and every Deal
 * node gains `computedContent` — the pre-calculated Deal Price / MRP /
 * Discount template the UI renders ahead of the written content. Handles both
 * flat listings and the deeply-nested homepage payload (coupons/deals live
 * inside components inside sections). Mutates in place and returns the same
 * reference; non-string fields (null/absent) are untouched.
 */
export function arrayizeOfferText<T>(node: T): T {
  if (Array.isArray(node)) {
    for (const item of node) arrayizeOfferText(item);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'offerText' && typeof value === 'string') {
        (node as Record<string, unknown>)[key] = splitOfferWords(value);
      } else if (BENEFIT_SUFFIX[key] && typeof value === 'string') {
        (node as Record<string, unknown>)[key] = formatBenefitText(
          value,
          BENEFIT_SUFFIX[key],
        );
      } else {
        arrayizeOfferText(value);
      }
    }
    if (DEAL_PRICE_KEYS.some((key) => key in (node as object))) {
      const computed = buildDealComputedContent(node as Record<string, unknown>);
      if (computed) (node as Record<string, unknown>).computedContent = computed;
    }
  }
  return node;
}
