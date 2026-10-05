import { isOfferCurrency, isNumericOfferAmount } from './offer-currency';
import { currentOfferContentLocalization } from './offer-content-localization';
import { formatDealDiscount } from './deal-discount';

export function offerAmountCurrency(value: unknown, currencyCode: unknown, usesCurrencyAmounts?: unknown): string | undefined {
  if (isOfferCurrency(currencyCode)) return currencyCode;
  if (usesCurrencyAmounts === true && typeof value === 'string' && isNumericOfferAmount(value)) {
    return currentOfferContentLocalization().currencyCode;
  }
  return undefined;
}

export function formatPublicDealDiscount(deal: {
  discount?: unknown; discountPrefix?: unknown; currencyCode?: unknown; usesCurrencyAmounts?: unknown;
}): string | null {
  return formatDealDiscount(deal.discount, deal.discountPrefix,
    offerAmountCurrency(deal.discount, deal.currencyCode, deal.usesCurrencyAmounts));
}
