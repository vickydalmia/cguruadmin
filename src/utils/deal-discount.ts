import { isOfferAmount, normalizeOfferAmount } from './offer-word-limits';

export const DEAL_DISCOUNT_PREFIXES = [
  { value: 'flat', label: 'Flat' },
  { value: 'upTo', label: 'Up To' },
  { value: 'extra', label: 'Extra' },
  { value: 'min', label: 'Min' },
  { value: 'under', label: 'Under' },
  { value: 'below', label: 'Below' },
] as const;

export type DealDiscountPrefix = (typeof DEAL_DISCOUNT_PREFIXES)[number]['value'];

const PREFIX_LABELS = new Map<string, string>(
  DEAL_DISCOUNT_PREFIXES.map(({ value, label }) => [value, label]),
);

const LEGACY_PREFIXES: Array<{
  pattern: RegExp;
  value: DealDiscountPrefix;
}> = [
  { pattern: /^flat\s+/i, value: 'flat' },
  { pattern: /^(?:up\s*to|upto)\s+/i, value: 'upTo' },
  { pattern: /^extra\s+/i, value: 'extra' },
  { pattern: /^min\s+/i, value: 'min' },
  { pattern: /^under\s+/i, value: 'under' },
  { pattern: /^below\s+/i, value: 'below' },
];

export function isDealDiscountPrefix(value: unknown): value is DealDiscountPrefix {
  return typeof value === 'string' && PREFIX_LABELS.has(value);
}

export function dealDiscountPrefixLabel(value: unknown): string | null {
  return typeof value === 'string' ? (PREFIX_LABELS.get(value) ?? null) : null;
}

/**
 * Assemble the public Deal discount while preserving unconverted legacy copy.
 * The prefix is deliberately an internal field and is removed by the response
 * walker after this formatter runs.
 */
export function formatDealDiscount(amount: unknown, prefix: unknown): string | null {
  if (typeof amount !== 'string' || !amount.trim()) return null;
  const trimmed = amount.trim();
  const label = dealDiscountPrefixLabel(prefix);
  if (!label || !isOfferAmount(trimmed)) return trimmed;
  return `${label} ${normalizeOfferAmount(trimmed)} OFF`;
}

/** Parse a recognizable old free-text discount into the new stored fields. */
export function parseLegacyDealDiscount(
  value: unknown,
): { discountPrefix: DealDiscountPrefix; discount: string } | null {
  if (typeof value !== 'string') return null;
  const withoutOff = value.trim().replace(/\s+off\s*$/i, '').trim();
  if (!withoutOff) return null;

  for (const prefix of LEGACY_PREFIXES) {
    if (!prefix.pattern.test(withoutOff)) continue;
    const amount = withoutOff.replace(prefix.pattern, '').trim();
    if (!isOfferAmount(amount)) return null;
    return {
      discountPrefix: prefix.value,
      discount: normalizeOfferAmount(amount),
    };
  }
  return null;
}
