import type { Core } from '@strapi/strapi';
import { isOfferCurrency, numericOfferAmountInput } from './offer-currency';

const BENEFITS = ['cashbackText', 'bankOfferText', 'prepaidText'];

/** Only explicit editorial writes opt in; imports and lifecycle writes are untouched. */
export function prepareOfferCurrencyWrite(
  data: Record<string, unknown>, stored: Record<string, unknown> | null, uid: string,
): void {
  const currencyTouched = Object.prototype.hasOwnProperty.call(data, 'currencyCode');
  const currency = currencyTouched ? data.currencyCode : stored?.currencyCode;
  const previous = stored?.currencyCode;
  const enabled = isOfferCurrency(currency) || stored?.usesCurrencyAmounts === true
    || (currencyTouched && isOfferCurrency(previous));
  if (!enabled) return;
  data.usesCurrencyAmounts = true;
  const fields = uid === 'api::deal.deal' ? [...BENEFITS, 'discount'] : BENEFITS;
  for (const field of fields) {
    if (!currencyTouched && !Object.prototype.hasOwnProperty.call(data, field)) continue;
    const value = Object.prototype.hasOwnProperty.call(data, field) ? data[field] : stored?.[field];
    if (typeof value !== 'string') continue;
    const numeric = numericOfferAmountInput(value, currency);
    if (numeric !== null) data[field] = numeric;
  }
}

export async function normaliseOfferCurrencyForWrite(
  strapi: Core.Strapi, uid: string, action: string, data: Record<string, unknown> | undefined,
  documentId?: string, locale?: string,
): Promise<void> {
  if (!data) return;
  const fields = [...BENEFITS, ...(uid === 'api::deal.deal' ? ['discount'] : [])];
  if (!['currencyCode', ...fields].some(field => Object.prototype.hasOwnProperty.call(data, field))) return;
  const stored = documentId && (action === 'update' || action === 'clone')
    ? await strapi.documents(uid as never).findOne({
        documentId, ...(locale ? { locale } : {}),
        fields: ['currencyCode', 'usesCurrencyAmounts', ...fields] as never,
      }) as Record<string, unknown> | null
    : null;
  prepareOfferCurrencyWrite(data, stored, uid);
}
