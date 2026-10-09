import { describe, it, expect } from 'vitest';
import { OFFER_CURRENCIES } from '../constants/offer-currencies';
import { parseOfferMoney } from './offer-currency';
import { validateOfferFields } from './offer-field-validation';
import { arrayizeOfferText } from './offer-text';
import { buildDealComputedContent } from './deal-computed-content';

describe('optional offer currencies', () => {
  it.each(['INR','SGD','AED','MYR','PHP','USD','SAR','KWD','QAR','OMR','BHD','EGP'])('supports %s on an individual offer', currencyCode => {
    expect(OFFER_CURRENCIES).toContain(currencyCode);
    expect(() => validateOfferFields({ currencyCode, cashbackText: '25' })).not.toThrow();
    expect(arrayizeOfferText({ currencyCode, cashbackText: '25' }).cashbackText).toBe(`${currencyCode} 25 Cashback`);
    expect(buildDealComputedContent({ currencyCode, salePrice: 25 })).toContain(`${currencyCode} 25`);
  });
  it('preserves legacy amounts and copy when currency is absent', () => {
    expect(arrayizeOfferText({ cashbackText: '₹100', bankOfferText: 'AED 50', prepaidText: '5%' })).toEqual({ cashbackText: '₹100 Cashback', bankOfferText: 'AED 50', prepaidText: '5% Prepaid OFF' });
    expect(() => validateOfferFields({ cashbackText: '100' })).toThrow();
    expect(() => validateOfferFields({ currencyCode: null, cashbackText: '$40' })).not.toThrow();
  });
  it('does not convert conflicting currency markers', () => {
    expect(() => validateOfferFields({ currencyCode: 'SAR', cashbackText: 'USD 50' })).toThrow(/uses USD/);
    expect(() => validateOfferFields({ currencyCode: 'BHR' })).toThrow(/supported currency/);
  });
  it('keeps percentages and three decimal amounts', () => {
    expect(arrayizeOfferText({ currencyCode: 'KWD', cashbackText: '1.125', prepaidText: '10%' })).toMatchObject({ cashbackText: 'KWD 1.125 Cashback', prepaidText: '10% Prepaid OFF' });
    expect(buildDealComputedContent({ currencyCode: 'KWD', salePrice: '1.125' })).toContain('KWD 1.125');
    expect(parseOfferMoney('KWD 1.125')).toEqual({ currencyCode: 'KWD', amount: '1.125' });
  });
});

it('validates partial currency changes against stored monetary fields', async () => {
  const { validateOfferFieldsForWrite } = await import('./offer-field-validation');
  const strapi = { documents: () => ({ findOne: async () => ({ currencyCode: 'USD', cashbackText: 'US$20' }) }) };
  await expect(validateOfferFieldsForWrite(strapi as never, 'api::coupon.coupon', 'update', { currencyCode: 'SAR' }, 'coupon-1')).rejects.toThrow(/uses USD/);
  await expect(validateOfferFieldsForWrite(strapi as never, 'api::coupon.coupon', 'update', { cashbackText: '20' }, 'coupon-1')).resolves.toBeUndefined();
  const legacyStrapi = { documents: () => ({ findOne: async () => ({ currencyCode: 'USD', cashbackText: '$20' }) }) };
  await expect(validateOfferFieldsForWrite(legacyStrapi as never, 'api::coupon.coupon', 'update', { currencyCode: null }, 'coupon-1')).resolves.toBeUndefined();
});

it('formats selected monetary discounts without changing manual coupon badges', () => {
  expect(arrayizeOfferText({ currencyCode: 'SAR', offerText: 'AED50 OFF', discount: '50', discountPrefix: 'flat' })).toMatchObject({ offerText: ['AED50', 'OFF'], discount: 'Flat SAR 50 OFF' });
});

it('keeps imported discount syntax valid without a manually selected currency', async () => {
  const { parseLegacyDealDiscount, formatDealDiscount } = await import('./deal-discount');
  const imported = parseLegacyDealDiscount('Flat $20 Off');
  expect(imported).toEqual({ discountPrefix: 'flat', discount: '$20' });
  expect(formatDealDiscount(imported!.discount, imported!.discountPrefix)).toBe('Flat $20 OFF');
  expect(() => validateOfferFields(
    { ...imported, currencyCode: null }, 'update', imported, true, 'api::deal.deal',
  )).not.toThrow();
  // Only an explicit editor selection changes the automatic monetary label.
  expect(formatDealDiscount('20', 'flat', 'SAR')).toBe('Flat SAR 20 OFF');
});
