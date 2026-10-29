import { describe, expect, it } from 'vitest';
import { evergreenForm, evergreenOutput, parsedForm, validOutput } from './__fixtures__/ads-fixtures';
import { checkEditorial } from './validate-editorial';

// Ad 1 from the audited CSV (CouponzGuru_Ad_Copy_Prompt_Revision/07_Validation_Report.json).
const AUDITED_AD = {
  headlines: [
    'Myntra Coupons And Offers', 'Explore Myntra With 40% Off', 'Find Myntra On CouponzGuru',
    'Browse Myntra Deal Details', 'Your Myntra Savings Search', 'Check The Myntra Offer Here',
    'View Myntra Savings Online', 'See The Listed Myntra Deal', 'Myntra Offers In One Place',
    'Start With CouponzGuru Today',
  ],
  descriptions: [
    '40% off Myntra is listed on CouponzGuru. Browse the offer and coupon details.',
    'Find the Myntra offer on CouponzGuru and review the details before you shop.',
    'Use CouponzGuru to explore Myntra savings and see the listed offer in one place.',
    'Check the Myntra listing on CouponzGuru as you plan your next shopping visit.',
  ],
};

describe('checkEditorial', () => {
  it('passes copy that follows the editorial rules', () => {
    expect(checkEditorial(validOutput().ads, parsedForm())).toEqual([]);
  });

  it('flags every pattern in the audited bad Myntra ad', () => {
    expect(checkEditorial([AUDITED_AD], parsedForm())).toEqual([
      'Ad 1 uses "Myntra" in 9 headlines; keep it to 7 at most and give the others a distinct offer fact or benefit.',
      'Ad 1 uses "Myntra" in 4 descriptions; keep it to 2, including description 1.',
      'Ad 1 mentions CouponzGuru in more than 1 headline.',
      'Ad 1 mentions CouponzGuru in more than 1 description.',
      'Ad 1 pairs "Myntra" with an offer fact in 1 headline; make at least 3 like "Myntra Up To 50% Off Shoes", using only figures from OFFER DETAILS.',
      'Ad 1 has 4 supporting headlines that only say browse/check/view/see/review/explore; replace them with offer facts, categories or saving benefits.',
      'Ad 1 headline 5 uses vague filler "savings search": "Your Myntra Savings Search".',
      'Ad 1 headline 8 uses vague filler "listed deal": "See The Listed Myntra Deal".',
      'Ad 1 description 3 uses vague filler "listed offer": "Use CouponzGuru to explore Myntra savings and see the listed offer in one place.".',
      'Ad 1 description 4 uses vague filler "shopping visit": "Check the Myntra listing on CouponzGuru as you plan your next shopping visit.".',
    ]);
  });

  it('does not count "CouponzGuru" as coupon wording', () => {
    const ad = validOutput().ads[0];
    ad.headlines[3] = 'Coupon Picks From CouponzGuru';
    ad.headlines[4] = 'Shoe Deals On CouponzGuru Now';
    const issues = checkEditorial([ad], parsedForm());
    expect(issues.some((issue) => issue.includes('coupon/promo wording'))).toBe(false);
    expect(issues).toContain('Ad 1 mentions CouponzGuru in more than 1 headline.');
  });

  it('allows a natural mix of coupon wording but flags stuffing above five headlines', () => {
    const ad = validOutput().ads[0]; // 3 coupon headlines already
    ad.headlines[4] = 'Shoe Coupons For Every Order';
    ad.headlines[6] = 'Promo Picks For New Footwear';
    expect(checkEditorial([ad], parsedForm())).toEqual([]);
    ad.headlines[3] = 'Coupons For Sneakers And Boots';
    expect(checkEditorial([ad], parsedForm())).toEqual([
      'Ad 1 has coupon/promo wording in 6 headlines; keep it to 5 at most and mix in discount, offer, deal or product messages.',
    ]);
  });

  it('wants the brand in description 1 and no repeated descriptions', () => {
    const ad = validOutput().ads[0];
    ad.descriptions[0] = ad.descriptions[2];
    expect(checkEditorial([ad], parsedForm())).toEqual([
      'Ad 1 description 1 should mention "Myntra" with the main offer.',
      `Ad 1 repeats the description "${ad.descriptions[2]}".`,
    ]);
  });

  it('flags the weak lines in the live Myntra output (30 Oct 2026)', () => {
    const live = {
      headlines: [
        'Myntra Coupons & Discounts', 'Up to 50% + Extra 20% Off', 'Save on Myntra Fashion Finds',
        'Myntra Clothing Discounts', 'Myntra Footwear for Less', 'Find Myntra Coupon Codes',
        'Extra 20% Off on Fashion', 'Choose a Deal Before Checkout', 'Up to 50% Off on Clothing',
        'See Which Coupon Terms Apply',
      ],
      descriptions: [
        'Get up to 50% off plus an extra 20% off with Myntra coupons for your next order.',
        'Shop fashion, clothing and footwear with savings of up to 50% plus an extra 20% off.',
        'Find Myntra coupon codes on CouponzGuru before you order, then head to checkout.',
        'Read the coupon terms to see how the discount applies to the items you want to buy.',
      ],
    };
    const form = parsedForm({ offerDetails: 'Up to 50% off on fashion. Extra 20% off with code FASHION20.' });
    expect(checkEditorial([live], form)).toEqual([
      'Ad 1 pairs "Myntra" with an offer fact in 0 headlines; make at least 3 like "Myntra Up To 50% Off Shoes", using only figures from OFFER DETAILS.',
      'Ad 1 headline 5 uses vague filler "for less": "Myntra Footwear for Less".',
      'Ad 1 headline 8 uses vague filler "choose a deal": "Choose a Deal Before Checkout".',
      'Ad 1 headline 10 uses vague filler "coupon terms": "See Which Coupon Terms Apply".',
      'Ad 1 description 4 uses vague filler "coupon terms": "Read the coupon terms to see how the discount applies to the items you want to buy.".',
    ]);
  });

  it('counts brand + category + coupon-term headlines for evergreen ads', () => {
    expect(checkEditorial(evergreenOutput().ads, evergreenForm())).toEqual([]);
    const ad = evergreenOutput().ads[0];
    ad.headlines[2] = 'Myntra Coupons For Your Order';
    ad.headlines[5] = 'Myntra Savings At Checkout';
    expect(checkEditorial([ad], evergreenForm())).toEqual([
      'Ad 1 pairs "Myntra" with a category and a coupon term in 2 headlines; make at least 3 like "Myntra Shoe Coupon Codes", using only supplied categories.',
    ]);
  });

  it('treats trust terms as optional but flags stuffing', () => {
    const ad = validOutput().ads[0];
    expect(checkEditorial([ad], parsedForm())).toEqual([]); // none used: fine
    ad.headlines[4] = 'Shoe Codes Manually Verified';
    ad.headlines[6] = 'Working Shoe Coupons Live Now';
    expect(checkEditorial([ad], parsedForm())).toEqual([]); // two: fine
    ad.headlines[3] = 'Extra 10% Off Today With Code';
    ad.headlines[0] = 'Myntra Coupon Codes Today';
    expect(checkEditorial([ad], parsedForm())).toEqual([
      'Ad 1 uses trust terms (Today, Live Now, Working, Manually Verified) in 4 headlines; keep them to 3 at most, where they read naturally.',
    ]);
  });

  it('flags headlines that are the same pattern with one word swapped', () => {
    const ad = validOutput().ads[0];
    // Replace two branded headlines so brand coverage stays the same.
    ad.headlines[5] = 'Myntra Fashion Up To 50% Off';
    ad.headlines[7] = 'Myntra Clothing Up To 50% Off';
    const form = parsedForm({ offerDetails: 'Up to 50% off on fashion and clothing. Extra 10% with code STYLE10, minimum 999.' });
    expect(checkEditorial([ad], form)).toEqual([
      'Ad 1 headlines 6 and 8 are the same pattern with one word swapped ("fashion/clothing"): "Myntra Fashion Up To 50% Off" / "Myntra Clothing Up To 50% Off". Rewrite one with a different shape.',
    ]);
  });

  it('does not compare short headlines, where one word changes the meaning', () => {
    const ad = validOutput().ads[0];
    ad.headlines[4] = 'Myntra Clothing Discounts';
    expect(checkEditorial([ad], parsedForm()).filter((issue) => issue.includes('one word swapped'))).toEqual([]);
  });
});
