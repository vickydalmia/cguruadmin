import { describe, it, expect, vi } from 'vitest';
import { prepareOfferCurrencyWrite } from './offer-currency-write';
import { validateOfferFields } from './offer-field-validation';
import { arrayizeOfferText } from './offer-text';
import { numericOfferAmountInput } from './offer-currency';
import { mapOffer } from '../api/search/services/search-response';
import { OFFER_CURRENCIES } from '../constants/offer-currencies';

const uid = 'api::deal.deal';
function save(patch: Record<string, unknown>, stored: Record<string, unknown> | null) {
  prepareOfferCurrencyWrite(patch, stored, uid);
  const effective = { ...stored, ...patch };
  validateOfferFields(effective, stored ? 'update' : 'create', stored, true, uid);
  return effective;
}

describe('manual currency transitions', () => {
  it('stores numbers, switches currencies, clears to default, and saves again', () => {
    let row = save({ currencyCode: 'SAR', cashbackText: numericOfferAmountInput('100', 'SAR'), discount: '50', discountPrefix: 'flat' }, null);
    expect(row).toMatchObject({ cashbackText: '100', usesCurrencyAmounts: true });
    expect(arrayizeOfferText({ ...row })).toMatchObject({ cashbackText: 'SAR 100 Cashback', discount: 'Flat SAR 50 OFF' });
    row = save({ currencyCode: 'AED' }, row);
    expect(arrayizeOfferText({ ...row })).toMatchObject({ cashbackText: 'AED 100 Cashback', discount: 'Flat AED 50 OFF' });
    row = save({ currencyCode: null }, row);
    const response = arrayizeOfferText({ ...row });
    expect(response).toMatchObject({ cashbackText: 'INR 100 Cashback', discount: 'Flat INR 50 OFF' });
    expect(response).not.toHaveProperty('usesCurrencyAmounts');
    expect(() => save({ cashbackText: '125' }, row)).not.toThrow();
  });
  it('normalizes prefixed inputs on save so later currency edits only change the selector', () => {
    const stored = save({ currencyCode: 'SAR', cashbackText: 'SAR 100' }, null);
    expect(stored.cashbackText).toBe('100');
    expect(save({ currencyCode: 'AED' }, stored)).toMatchObject({ cashbackText: '100' });
    expect(save({ currencyCode: null }, stored)).toMatchObject({ cashbackText: '100', usesCurrencyAmounts: true });
    expect(numericOfferAmountInput('SAR 100', 'SAR')).toBe('100');
    expect(numericOfferAmountInput('10%', 'SAR')).toBeNull();
    expect(numericOfferAmountInput('USD 100', 'SAR')).toBeNull();
  });
  it('keeps legacy numeric prose and explicit money unchanged until opting in', () => {
    const row = { cashbackText: '100', bankOfferText: '$20' };
    const patch = { ...row };
    prepareOfferCurrencyWrite(patch, row, uid);
    expect(patch).toEqual(row);
    expect(arrayizeOfferText({ ...row })).toEqual({ cashbackText: '100', bankOfferText: '$20 Bank OFF' });
    expect(() => save({ currencyCode: 'SAR', cashbackText: 'USD 20' }, null)).toThrow();
  });
  it('uses the same formatted discount in search cards and generated details', () => {
    for (const currencyCode of ['SAR', null]) {
      const hit = mapOffer({ documentId: 'deal1', title: 'Phone', currencyCode, usesCurrencyAmounts: true, discountPrefix: 'flat', discount: '50', salePrice: 100 }, 'deal');
      const expected = `Flat ${currencyCode ?? 'INR'} 50 OFF`;
      expect(hit.discount).toBe(expected);
      expect(hit.computedContent).toContain(`Discount - ${expected}`);
    }
  });
  it('has a fixed catalogue independent of runtime currency enumeration', async () => {
    expect(OFFER_CURRENCIES).toEqual(expect.arrayContaining(['INR','SGD','AED','MYR','PHP','USD','SAR','KWD','QAR','OMR','BHD','EGP']));
    const spy = vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => { throw new Error('runtime unavailable'); });
    try {
      vi.resetModules();
      const { isOfferCurrency } = await import('./offer-currency');
      expect(isOfferCurrency('SAR')).toBe(true);
      expect(isOfferCurrency('BHR')).toBe(false);
    } finally { spy.mockRestore(); }
  });
});

it('uses the selected currency for ambiguous dollars but keeps explicit currency checks', () => {
  const row = save({ currencyCode: 'SGD', cashbackText: '$100' }, null);
  expect(row.cashbackText).toBe('100');
  expect(arrayizeOfferText({ ...row }).cashbackText).toBe('SGD 100 Cashback');
  expect(save({ currencyCode: null }, row).cashbackText).toBe('100');
  expect(() => save({ currencyCode: 'SGD', cashbackText: 'US$100' }, null)).toThrow(/uses USD/);
  expect(arrayizeOfferText({ cashbackText: '$100' }).cashbackText).toBe('$100 Cashback');
});

it.each(['INR', 'AED', 'EUR', 'MYR', 'PHP'])(
  'preserves a stored dollar amount and rejects changing it to %s', currencyCode => {
    const stored = { discount: '$40', discountPrefix: 'flat', currencyCode: null };
    const patch: Record<string, unknown> = { currencyCode };
    prepareOfferCurrencyWrite(patch, stored, uid);
    expect(patch).not.toHaveProperty('discount');
    expect(stored.discount).toBe('$40');
    expect(numericOfferAmountInput('$40', currencyCode)).toBeNull();
    expect(() => save(patch, stored)).toThrow(/This amount uses \$/);
  },
);

it.each(['USD', 'SGD', 'AUD', 'CAD', 'HKD', 'NZD'])(
  'accepts a bare dollar amount under %s', currencyCode => {
    expect(save({ currencyCode, discount: '$40', discountPrefix: 'flat' }, null).discount).toBe('40');
  },
);

it.each(['cashbackText', 'bankOfferText', 'prepaidText', 'discount'])(
  'reports only the currency conflict for %s', field => {
    let caught: unknown;
    try {
      save({ currencyCode: 'USD', [field]: 'EUR 100', ...(field === 'discount' ? { discountPrefix: 'flat' } : {}) }, null);
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ details: { errors: [
      { path: [field], message: expect.stringContaining('This amount uses EUR') },
    ] } });
  },
);
