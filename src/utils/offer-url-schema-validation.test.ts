import { describe, expect, it } from 'vitest';
import couponSchema from '../api/coupon/content-types/coupon/schema.json';
import dealSchema from '../api/deal/content-types/deal/schema.json';

const myntraAffiliateLink =
  'https://www.myntra.com/adidas?sort=popularity&rf=Discount Range:30.0_100.0_30.0 TO 100.0&utm_source=admitad&utm_medium=affiliate&utm_campaign=306480_ADIDAS';

describe('coupon/deal affiliateLink schema', () => {
  it.each([
    ['coupon', couponSchema],
    ['deal', dealSchema],
  ])('accepts broad valid http(s) affiliate URLs for %s', (_name, schema) => {
    const pattern = new RegExp(schema.attributes.affiliateLink.regex);

    expect(pattern.test(myntraAffiliateLink)).toBe(true);
    expect(pattern.test('https://merchant.example/sale?utm_source=a+b&x=%E2%9C%93')).toBe(true);
    expect(pattern.test('http://localhost:3000/preview path?next=/offers')).toBe(true);
  });

  it.each([
    ['coupon', couponSchema],
    ['deal', dealSchema],
  ])('keeps unsafe affiliate URLs out of the %s schema', (_name, schema) => {
    const pattern = new RegExp(schema.attributes.affiliateLink.regex);

    expect(pattern.test('javascript:alert(1)')).toBe(false);
    expect(pattern.test('data:text/html,unsafe')).toBe(false);
    expect(pattern.test('https://merchant.example/<script>')).toBe(false);
    expect(pattern.test('https://merchant.example/a\nb')).toBe(false);
  });
});
