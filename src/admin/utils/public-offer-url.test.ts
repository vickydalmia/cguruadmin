import { describe, expect, it } from 'vitest';

import { buildPublicOfferUrl } from './public-offer-url';

describe('buildPublicOfferUrl', () => {
  it('builds a coupon page link from the numeric Strapi id', () => {
    expect(
      buildPublicOfferUrl(
        'api::coupon.coupon',
        123,
        'https://beta.couponzguru.com/'
      )
    ).toBe('https://beta.couponzguru.com/coupon/123/');
  });

  it('builds a deal page link from a numeric string id', () => {
    expect(
      buildPublicOfferUrl(
        'api::deal.deal',
        '456',
        'https://www.couponzguru.com/admin'
      )
    ).toBe('https://www.couponzguru.com/deal/456/');
  });

  it('does not build links for other content types or document ids', () => {
    expect(buildPublicOfferUrl('api::store.store', 123)).toBeNull();
    expect(buildPublicOfferUrl('api::coupon.coupon', 'long-document-id')).toBeNull();
    expect(buildPublicOfferUrl('api::deal.deal', 0)).toBeNull();
  });

  it('does not generate a link when the public site environment value is missing or invalid', () => {
    expect(buildPublicOfferUrl('api::coupon.coupon', 9)).toBeNull();
    expect(buildPublicOfferUrl('api::coupon.coupon', 9, '')).toBeNull();
    expect(buildPublicOfferUrl('api::coupon.coupon', 9, 'not-a-url')).toBeNull();
    expect(buildPublicOfferUrl('api::coupon.coupon', 9, 'ftp://example.com')).toBeNull();
  });
});
