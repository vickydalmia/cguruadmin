// Browser-safe currency policy shared by the editor and server validators.
import { OFFER_CURRENCIES } from '../constants/offer-currencies';
const currencies = new Set(OFFER_CURRENCIES);
// Explicit dollar-currency policy; never infer this from runtime display names.
const DOLLAR_CURRENCIES = new Set([
  'AUD', 'BBD', 'BMD', 'BND', 'BSD', 'BZD', 'CAD', 'FJD', 'GYD', 'HKD',
  'JMD', 'KYD', 'LRD', 'NAD', 'NZD', 'SBD', 'SGD', 'SRD', 'TTD', 'TWD',
  'USD', 'XCD', 'ZWL',
]);
export function isOfferCurrency(value: unknown): value is string {
  return typeof value === 'string' && currencies.has(value);
}

const NUMBER = String.raw`(?:\d+|\d{1,3}(?:,\d{2,3})+)(?:\.\d{1,3})?`;
const MONEY = new RegExp(`^(?:(₹|rs\\.?|inr|US\\$|S\\$|RM|₱|\\$|[A-Z]{3})\\s*)?(${NUMBER})$`, 'i');
const ALIASES: Record<string, string> = {
  '₹': 'INR', RS: 'INR', 'RS.': 'INR', 'US$': 'USD',
  'S$': 'SGD', RM: 'MYR', '₱': 'PHP',
};
export function parseOfferMoney(value: string, selectedCurrency?: unknown): { currencyCode: string | null; amount: string } | null {
  const match = value.trim().match(MONEY);
  if (!match) return null;
  const marker = match[1]?.toUpperCase();
  // Keep an unresolved dollar marker so a non-dollar selection conflicts.
  const currencyCode = marker === '$'
    ? (isOfferCurrency(selectedCurrency) && DOLLAR_CURRENCIES.has(selectedCurrency) ? selectedCurrency : '$')
    : marker ? ALIASES[marker] ?? marker : null;
  if (currencyCode && currencyCode !== '$' && !isOfferCurrency(currencyCode)) return null;
  return { currencyCode, amount: match[2].replace(/,/g, '') };
}

/** Explicit selections format amounts; a conflicting marker is never relabelled. */
export function selectedOfferAmount(value: string, currencyCode: unknown): string | null {
  if (!isOfferCurrency(currencyCode)) return null;
  const money = parseOfferMoney(value, currencyCode);
  if (!money || (money.currencyCode && money.currencyCode !== currencyCode)) return null;
  return `${currencyCode} ${money.amount}`;
}

/** Editor/storage normalization: never bake the selected currency into a number. */
export function numericOfferAmountInput(value: string, currencyCode: unknown): string | null {
  if (!isOfferCurrency(currencyCode)) return null;
  const money = parseOfferMoney(value, currencyCode);
  return money && (!money.currencyCode || money.currencyCode === currencyCode) ? money.amount : null;
}

/** Numeric amounts may follow the site currency after the selector is cleared. */
export function isNumericOfferAmount(value: string): boolean {
  const money = parseOfferMoney(value);
  return money !== null && money.currencyCode === null;
}
