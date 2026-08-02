import { describe, expect, it } from 'vitest';
import { splitOfferWords, arrayizeOfferText, formatBenefitText } from './offer-text';

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
    const coupon = { title: 'x', offerText: 'UPTO 50% OFF', cashbackText: '15%' };
    arrayizeOfferText(coupon);
    expect(coupon.offerText).toEqual(['UPTO', '50%', 'OFF']);
    // Benefit amounts gain their wording on the way out.
    expect(coupon.cashbackText).toBe('15% Cashback');
  });

  it('appends the wording to every benefit amount', () => {
    const deal = {
      cashbackText: '15%',
      bankOfferText: 'Rs. 2,000',
      prepaidText: '$40',
    };
    arrayizeOfferText(deal);
    expect(deal.cashbackText).toBe('15% Cashback');
    expect(deal.bankOfferText).toBe('₹2000 Bank OFF');
    expect(deal.prepaidText).toBe('$40 Prepaid OFF');
  });

  it('passes legacy full-text benefit values through unchanged', () => {
    const coupon = {
      cashbackText: '15% Cashback',
      bankOfferText: 'HDFC Bank OFF',
      prepaidText: null as string | null,
    };
    arrayizeOfferText(coupon);
    expect(coupon.cashbackText).toBe('15% Cashback');
    expect(coupon.bankOfferText).toBe('HDFC Bank OFF');
    expect(coupon.prepaidText).toBeNull();
  });

  it('walks arrays and deeply-nested Coupon structures', () => {
    const payload = {
      hero: {
        products: [{ deal: { discount: 'FLAT ₹625 OFF' } }],
      },
      topOffers: { items: [{ coupon: { offerText: 'EXTRA 18% OFF' } }] },
    };
    arrayizeOfferText(payload);
    expect(payload.hero.products[0].deal.offerText).toBeUndefined();
    expect(payload.topOffers.items[0].coupon.offerText).toEqual(['EXTRA', '18%', 'OFF']);
  });

  it('formats Deal discount and strips its CMS-only prefix', () => {
    const payload: any = {
      deal: {
        salePrice: 1299,
        discount: 'Rs. 2,000',
        discountPrefix: 'upTo',
      },
    };
    arrayizeOfferText(payload);
    expect(payload.deal.discount).toBe('Up To ₹2000 OFF');
    expect(payload.deal.discountPrefix).toBeUndefined();
    expect(payload.deal.computedContent).toContain('Discount - Up To ₹2000 OFF');
  });

  it('omits OFF from Under and Below Deal discounts everywhere in the payload', () => {
    const payload: any = {
      deals: [
        { discount: 'Rs. 2,000', discountPrefix: 'under' },
        { discount: '10 %', discountPrefix: 'below' },
      ],
    };
    arrayizeOfferText(payload);
    expect(payload.deals[0].discount).toBe('Under ₹2000');
    expect(payload.deals[0].computedContent).toContain('Discount - Under ₹2000');
    expect(payload.deals[1].discount).toBe('Below 10%');
    expect(payload.deals[1].computedContent).toContain('Discount - Below 10%');
  });

  it('preserves an unconverted legacy Deal discount while stripping the prefix field', () => {
    const deal: any = { discount: 'Buy one get one', discountPrefix: null };
    arrayizeOfferText(deal);
    expect(deal.discount).toBe('Buy one get one');
    expect(deal.discountPrefix).toBeUndefined();
  });

  it('leaves null / absent offerText untouched', () => {
    const coupon: { offerText: string | null } = { offerText: null };
    arrayizeOfferText(coupon);
    expect(coupon.offerText).toBeNull();
  });

  it('attaches computedContent to deal nodes, including nested ones', () => {
    const payload: any = {
      deal: { salePrice: '1299.00', mrp: 2999, discount: '56% OFF', content: '<p>x</p>' },
      topDeals: { deals: [{ salePrice: 499 }] },
      coupon: { title: 'no prices here' },
    };
    arrayizeOfferText(payload);
    expect(payload.deal.computedContent).toBe(
      '<p><strong>Deal Price - ₹1,299</strong></p><p>MRP - ₹2,999</p><p>Discount - 56% OFF</p>',
    );
    // The written content is sent alongside, untouched.
    expect(payload.deal.content).toBe('<p>x</p>');
    expect(payload.topDeals.deals[0].computedContent).toBe(
      '<p><strong>Deal Price - ₹499</strong></p>',
    );
    // Coupons never gain the field.
    expect('computedContent' in payload.coupon).toBe(false);
  });

  it('omits computedContent when a deal has no pricing data at all', () => {
    const deal: any = { salePrice: null, mrp: null, discount: null };
    arrayizeOfferText(deal);
    expect('computedContent' in deal).toBe(false);
  });
});

describe('formatBenefitText', () => {
  it('normalizes an amount and appends the wording', () => {
    expect(formatBenefitText('10%', 'Cashback')).toBe('10% Cashback');
    expect(formatBenefitText('10 %', 'Cashback')).toBe('10% Cashback');
    expect(formatBenefitText('Rs.100', 'Bank OFF')).toBe('₹100 Bank OFF');
    expect(formatBenefitText('INR 2,000', 'Bank OFF')).toBe('₹2000 Bank OFF');
    expect(formatBenefitText('₹100', 'Prepaid OFF')).toBe('₹100 Prepaid OFF');
    expect(formatBenefitText('$40', 'Prepaid OFF')).toBe('$40 Prepaid OFF');
  });

  it('leaves non-amount (legacy) values and blanks unchanged', () => {
    expect(formatBenefitText('15% Cashback', 'Cashback')).toBe('15% Cashback');
    expect(formatBenefitText('Prepaid Free Shipping', 'Prepaid OFF')).toBe(
      'Prepaid Free Shipping',
    );
    expect(formatBenefitText('  ', 'Cashback')).toBe('');
  });
});
