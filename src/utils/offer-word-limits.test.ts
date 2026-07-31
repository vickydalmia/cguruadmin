import { describe, expect, it } from 'vitest';
import {
  isBenefitAmount,
  isOfferAmount,
  normalizeBenefitAmount,
  normalizeOfferAmount,
} from './offer-word-limits';

describe('isBenefitAmount', () => {
  it('accepts percents and currency amounts', () => {
    for (const value of ['10%', '19.2%', '10 %', '₹100', 'Rs.100', 'rs 2,000', 'INR 500', '$40']) {
      expect(isBenefitAmount(value), value).toBe(true);
      expect(isOfferAmount(value), value).toBe(true);
    }
  });

  it('rejects wording, bare numbers, and incomplete symbols', () => {
    for (const value of ['15% Cashback', 'Bank OFF', '100', '%', '₹', 'Rs.', 'Free Shipping', '10%%']) {
      expect(isBenefitAmount(value), value).toBe(false);
      expect(isOfferAmount(value), value).toBe(false);
    }
  });
});

describe('normalizeBenefitAmount', () => {
  it('canonicalizes accepted amounts', () => {
    expect(normalizeBenefitAmount('10 %')).toBe('10%');
    expect(normalizeBenefitAmount('Rs. 2,000')).toBe('₹2000');
    expect(normalizeBenefitAmount('INR 500')).toBe('₹500');
    expect(normalizeBenefitAmount('$ 40')).toBe('$40');
    expect(normalizeBenefitAmount('₹100')).toBe('₹100');
    expect(normalizeOfferAmount('Rs. 2,000')).toBe('₹2000');
  });

  it('passes non-amounts through unchanged', () => {
    expect(normalizeBenefitAmount('15% Cashback')).toBe('15% Cashback');
  });
});
