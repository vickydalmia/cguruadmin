import { describe, expect, it } from 'vitest';
import { evergreenForm, evergreenOutput, parsedForm, validOutput } from './__fixtures__/ads-fixtures';
import { validateCreative } from './validate-creative';

function withHeadline(index: number, text: string) {
  const output = validOutput();
  output.ads[0].headlines[index] = text;
  return output;
}

describe('validateCreative', () => {
  it('accepts copy that follows every rule', () => {
    expect(validateCreative(validOutput(), parsedForm())).toEqual([]);
  });

  it('checks ad, headline and description counts', () => {
    const output = validOutput();
    output.ads[0].headlines.pop();
    output.ads[0].descriptions.pop();
    expect(validateCreative(output, parsedForm())).toEqual([
      'Ad 1 needs exactly 10 headlines (got 9).',
      'Ad 1 needs exactly 4 descriptions (got 3).',
    ]);
    expect(validateCreative(validOutput({ ads: [] }), parsedForm())).toEqual(['Return exactly 1 ad (got 0).']);
    const two = validOutput();
    two.ads.push(structuredClone(two.ads[0]));
    expect(validateCreative(two, parsedForm())).toEqual(['Return exactly 1 ad (got 2).']);
  });

  it('checks lengths with a repair-ready message', () => {
    expect(validateCreative(withHeadline(2, 'Too Short Headline'), parsedForm())).toEqual([
      'Ad 1 headline 3 is 18 characters; it must be 24-30: "Too Short Headline".',
    ]);
  });

  it('requires the brand and coupon intent in headline 1', () => {
    expect(validateCreative(withHeadline(0, 'Great Savings On Shoes Today'), parsedForm())).toEqual([
      'Ad 1 headline 1 must contain the full brand name "Myntra".',
      'Ad 1 headline 1 must say coupon, promo, discount.',
    ]);
  });

  it('rejects numbers that are not in the offer details', () => {
    expect(validateCreative(withHeadline(1, 'Flat 70% Off On Shoes Today'), parsedForm())).toEqual([
      'Ad 1 headline 2 uses 70, which is not in OFFER DETAILS. Remove it or use a stated figure: "Flat 70% Off On Shoes Today".',
    ]);
  });

  it('does not treat digits in the brand name as claims', () => {
    const output = validOutput();
    output.ads.forEach((ad) => { ad.headlines[0] = 'VK1 Coupon Codes And Offers'; });
    expect(validateCreative(output, parsedForm({ brandName: 'VK1' }))
      .filter((problem) => problem.includes('not in OFFER DETAILS'))).toEqual([]);
  });

  it('rejects banned phrases, shouting and duplicates', () => {
    const output = withHeadline(4, 'Guaranteed Shoe Savings Here');
    output.ads[0].headlines[5] = 'HUGE Savings On Shoes Today';
    output.ads[0].headlines[6] = output.ads[0].headlines[7];
    expect(validateCreative(output, parsedForm())).toEqual([
      'Ad 1 repeats the headline "Myntra Extra 10% With STYLE10".',
      'Ad 1 headline 5 uses the banned phrase "guarantee": "Guaranteed Shoe Savings Here".',
      'Ad 1 headline 6 uses the ALL-CAPS word "HUGE".',
    ]);
  });

  it('requires the full brand in at least 5 of 10 headlines per ad', () => {
    const output = validOutput();
    // Fixture ad 1 has the brand in 6 headlines; dropping two leaves 4.
    output.ads[0].headlines[8] = 'Shoe Offers Over 999 Listed';
    output.ads[0].headlines[9] = 'Discount Coupon Codes For All';
    expect(validateCreative(output, parsedForm())).toEqual([
      'Ad 1 has the full brand name "Myntra" in 4 of 10 headlines; at least 5 are required. Add it to supporting headlines without removing the main offer.',
    ]);
    output.ads[0].headlines[8] = 'Myntra Shoe Offers Over 999';
    expect(validateCreative(output, parsedForm())).toEqual([]);
  });

  it('rejects spreadsheet formula prefixes', () => {
    expect(validateCreative(withHeadline(3, '=Extra 10% Off With A Code'), parsedForm())).toEqual([
      'Ad 1 headline 4 must not start with = + - or @.',
    ]);
  });

  describe('evergreen', () => {
    function evergreenWith(text: string) {
      const output = evergreenOutput();
      output.ads[0].headlines[3] = text;
      return validateCreative(output, evergreenForm());
    }

    it('accepts number-free, undated copy', () => {
      expect(validateCreative(evergreenOutput(), evergreenForm())).toEqual([]);
    });

    it('rejects any number, even one a shopper would expect', () => {
      expect(evergreenWith('Up To 40% Off On Footwear')).toEqual([
        'Ad 1 headline 4 uses 40; evergreen ads must not contain numbers. Rewrite without it: "Up To 40% Off On Footwear".',
      ]);
    });

    it('rejects time and event words as whole words', () => {
      expect(evergreenWith('Diwali Savings On Footwear')).toEqual([
        'Ad 1 headline 4 uses "diwali", which goes stale; evergreen ads must stay true on any day: "Diwali Savings On Footwear".',
      ]);
      expect(evergreenWith('Shoe Savings Ending Tonight')[0]).toContain('uses "tonight"');
      // "trends" contains "ends" but is not a time word.
      expect(evergreenWith('Fashion Trends For Less Cost')).toEqual([]);
    });

    it('still allows digits that belong to the brand name', () => {
      const output = evergreenOutput();
      output.ads.forEach((ad) => { ad.headlines[0] = 'VK1 Coupons And Discounts'; });
      const problems = validateCreative(output, evergreenForm({ brandName: 'VK1' }));
      expect(problems.filter((problem) => problem.includes('numbers'))).toEqual([]);
    });
  });

  describe('offer stacking', () => {
    const offer = 'Up to 50% off on fashion. Extra 20% off with code FASHION20.';
    function withLine(text: string, offerDetails = offer) {
      const output = validOutput();
      output.ads[0].descriptions[2] = text;
      return validateCreative(output, parsedForm({ offerDetails }))
        .filter((problem) => problem.includes('joins offers'));
    }

    it('blocks "+" or "plus" between offers the details do not combine', () => {
      expect(withLine('Get up to 50% off plus an extra 20% off with Myntra coupons for your next order.')).toEqual([
        'Ad 1 description 3 joins offers with "plus", but OFFER DETAILS does not say they can be combined. State each offer separately: "Get up to 50% off plus an extra 20% off with Myntra coupons for your next order.".',
      ]);
      expect(withLine('Shop fashion at up to 50% + extra 20% off when you apply a coupon before you pay.')).toHaveLength(1);
    });

    it('allows the wording when the offer details say the offers combine', () => {
      const combined = 'Up to 50% off on fashion, plus an extra 20% off on top with code FASHION20.';
      expect(withLine('Get up to 50% off plus an extra 20% off with Myntra coupons for your next order.', combined)).toEqual([]);
    });

    it('treats an explicit "not stackable" as no permission', () => {
      const denied = 'Up to 50% off on fashion + extra 20% with HDFC cards (not stackable).';
      expect(withLine('Get up to 50% off plus an extra 20% off with Myntra coupons for your next order.', denied)).toHaveLength(1);
    });

    it('ignores "plus" in lines without a number', () => {
      expect(withLine('Myntra coupons plus fashion deals in one place so you can save before you check out.')).toEqual([]);
    });
  });

  it('allows "Today" as a freshness signal but blocks it as a deadline', () => {
    expect(validateCreative(withHeadline(3, 'Extra 10% Off Code Today'), parsedForm())).toEqual([]);
    expect(validateCreative(withHeadline(3, 'Extra 10% Off, Today Only'), parsedForm())).toEqual([
      'Ad 1 headline 4 uses the banned phrase "today only": "Extra 10% Off, Today Only".',
    ]);
    const evergreen = evergreenOutput();
    evergreen.ads[0].headlines[3] = 'Fashion Coupon Codes Today';
    expect(validateCreative(evergreen, evergreenForm())).toEqual([]);
  });
});
