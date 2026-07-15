import { describe, expect, it } from 'vitest';
import { splitOfferWords, arrayizeOfferText } from './offer-text';

describe('splitOfferWords', () => {
  it('splits a badge string into its render words', () => {
    expect(splitOfferWords('EXTRA 18% OFF')).toEqual(['EXTRA', '18%', 'OFF']);
    expect(splitOfferWords('18% OFF')).toEqual(['18%', 'OFF']);
    expect(splitOfferWords('FLAT ₹625 OFF')).toEqual(['FLAT', '₹625', 'OFF']);
  });

  it('collapses extra whitespace and ignores padding', () => {
    expect(splitOfferWords('  FLAT   OFF ')).toEqual(['FLAT', 'OFF']);
  });
});

describe('arrayizeOfferText', () => {
  it('converts a top-level offerText string to an array of words', () => {
    const coupon = { title: 'x', offerText: 'UPTO 50% OFF', cashbackText: '15% Cashback' };
    arrayizeOfferText(coupon);
    expect(coupon.offerText).toEqual(['UPTO', '50%', 'OFF']);
    // Only offerText is transformed.
    expect(coupon.cashbackText).toBe('15% Cashback');
  });

  it('walks arrays and deeply-nested structures (homepage-shaped)', () => {
    const payload = {
      hero: {
        products: [
          { deal: { offerText: 'FLAT ₹625 OFF' } },
          { deal: { offerText: '40% OFF' } },
        ],
      },
      topOffers: { items: [{ coupon: { offerText: 'EXTRA 18% OFF' } }] },
    };
    arrayizeOfferText(payload);
    expect(payload.hero.products[0].deal.offerText).toEqual(['FLAT', '₹625', 'OFF']);
    expect(payload.hero.products[1].deal.offerText).toEqual(['40%', 'OFF']);
    expect(payload.topOffers.items[0].coupon.offerText).toEqual(['EXTRA', '18%', 'OFF']);
  });

  it('leaves null / absent offerText untouched', () => {
    const coupon: { offerText: string | null } = { offerText: null };
    arrayizeOfferText(coupon);
    expect(coupon.offerText).toBeNull();
  });
});
