import { describe, expect, it } from 'vitest';
import { validateOfferFields } from './offer-field-validation';

describe('validateOfferFields', () => {
  it('accepts values within the word limits', () => {
    expect(() =>
      validateOfferFields({
        offerText: 'EXTRA 18% OFF', // 3 words
        cashbackText: '15% Cashback', // 2 words
        bankOfferText: '12% Bank OFF', // 3 words
      })
    ).not.toThrow();
  });

  it('rejects an offerText with more than 3 words', () => {
    expect(() => validateOfferFields({ offerText: 'GET FLAT 50% OFF NOW' })).toThrow(
      /Offer text must be at most 3 words/
    );
  });

  it('rejects a cashbackText with more than 2 words', () => {
    expect(() => validateOfferFields({ cashbackText: 'Up To 15% Cashback' })).toThrow(
      /Cashback text must be at most 2 words/
    );
  });

  it('rejects a bankOfferText with more than 3 words', () => {
    expect(() =>
      validateOfferFields({ bankOfferText: 'Extra 12% Bank Discount Offer' })
    ).toThrow(/Bank offer text must be at most 3 words/);
  });

  it('ignores empty, null, and absent fields (partial updates)', () => {
    expect(() => validateOfferFields({ offerText: '', cashbackText: null })).not.toThrow();
    expect(() => validateOfferFields({ title: 'unrelated' })).not.toThrow();
    expect(() => validateOfferFields(null)).not.toThrow();
  });

  it('collects multiple problems in one error', () => {
    try {
      validateOfferFields({
        offerText: 'one two three four',
        bankOfferText: 'a b c d',
      });
      throw new Error('expected validateOfferFields to throw');
    } catch (err: any) {
      expect(err.details?.errors).toHaveLength(2);
      expect(err.details.errors.map((e: any) => e.path[0])).toEqual([
        'offerText',
        'bankOfferText',
      ]);
    }
  });
});
