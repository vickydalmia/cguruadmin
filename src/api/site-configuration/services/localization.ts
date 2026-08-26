import { toValidationError, type Problem } from '../../../utils/write-validation/problems';

export type LocalizationPreview = {
  currencyCode: string;
  currencySymbol: string;
  /** Prefix used for public price rendering; India keeps its legacy "Rs." label. */
  priceLabel: string;
  numberExample: string;
  dateExample: string;
};

function currencySymbol(locale: string, currencyCode: string): string {
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 0,
  }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currencyCode;
}

export function localizationPreview(
  locale: string,
  currencyCode: string,
  timezone: string,
  countryCode?: string,
): LocalizationPreview {
  const symbol = currencySymbol(locale, currencyCode);
  return {
    currencyCode,
    currencySymbol: symbol,
    priceLabel: countryCode === 'IN' ? 'Rs.' : symbol,
    numberExample: new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
    }).format(1234.56),
    dateExample: new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: timezone,
    }).format(new Date('2026-08-26T12:00:00Z')),
  };
}

export function validateLocalization(data: any): void {
  const problems: Problem[] = [];
  const locale = String(data?.locale ?? '').trim();
  const currencyCode = String(data?.currencyCode ?? '').trim().toUpperCase();
  const timezone = String(data?.timezone ?? '').trim();

  try {
    Intl.getCanonicalLocales(locale);
    new Intl.NumberFormat(locale).format(1);
  } catch {
    problems.push({ path: ['locale'], message: `“${locale}” is not a supported locale.` });
  }
  try {
    const supportedValuesOf = (
      Intl as typeof Intl & {
        supportedValuesOf?: (key: 'currency') => string[];
      }
    ).supportedValuesOf;
    if (
      supportedValuesOf &&
      !new Set(supportedValuesOf('currency')).has(currencyCode)
    ) {
      throw new RangeError('unsupported currency');
    }
    new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency: currencyCode,
    }).format(1);
  } catch {
    problems.push({ path: ['currencyCode'], message: `“${currencyCode}” is not a valid ISO 4217 currency code.` });
  }
  try {
    new Intl.DateTimeFormat(locale || 'en', { timeZone: timezone }).format();
  } catch {
    problems.push({ path: ['timezone'], message: `“${timezone}” is not a supported IANA timezone.` });
  }

  if (problems.length > 0) throw toValidationError(problems);
}
