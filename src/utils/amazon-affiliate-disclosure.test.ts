import { describe, expect, it } from 'vitest';

import {
  AMAZON_AFFILIATE_DISCLOSURE_HTML,
  isAmazonDeal,
  withAmazonAffiliateDisclosure,
} from './amazon-affiliate-disclosure';
import dealSchema from '../api/deal/content-types/deal/schema.json';

const AMAZON_STORE = { name: 'Amazon India', slug: 'amazon-coupons' };
const AMAZON_BRAND = { name: 'Amazon', slug: 'amazon' };

describe('Amazon affiliate disclosure', () => {
  it('exposes an opt-in boolean on Product Deals', () => {
    expect(dealSchema.attributes.enableAmazonAffiliateDisclosure).toEqual({
      type: 'boolean',
      default: false,
    });
  });

  it('recognizes Amazon in either merchant taxonomy', () => {
    expect(isAmazonDeal({ stores: [AMAZON_STORE] })).toBe(true);
    expect(isAmazonDeal({ brands: [AMAZON_BRAND] })).toBe(true);
    expect(isAmazonDeal({ stores: [{ name: 'Flipkart', slug: 'flipkart' }] })).toBe(
      false,
    );
  });

  it('appends the disclosure after all authored conditions', () => {
    const authored = '<p>Bank offer applies.</p><p>No returns.</p>';
    expect(
      withAmazonAffiliateDisclosure({
        content: authored,
        enableAmazonAffiliateDisclosure: true,
        brands: [AMAZON_BRAND],
      }),
    ).toBe(`${authored}${AMAZON_AFFILIATE_DISCLOSURE_HTML}`);
  });

  it('creates the final condition when no authored content exists', () => {
    expect(
      withAmazonAffiliateDisclosure({
        content: null,
        enableAmazonAffiliateDisclosure: true,
        stores: [AMAZON_STORE],
      }),
    ).toBe(AMAZON_AFFILIATE_DISCLOSURE_HTML);
  });

  it('does nothing unless both the opt-in and Amazon relation are present', () => {
    const content = '<p>Existing condition.</p>';
    expect(
      withAmazonAffiliateDisclosure({
        content,
        enableAmazonAffiliateDisclosure: false,
        brands: [AMAZON_BRAND],
      }),
    ).toBe(content);
    expect(
      withAmazonAffiliateDisclosure({
        content,
        enableAmazonAffiliateDisclosure: true,
        brands: [{ name: 'Nike', slug: 'nike-coupons' }],
      }),
    ).toBe(content);
  });

  it('is idempotent when the response is decorated more than once', () => {
    const content = `<p>Existing.</p>${AMAZON_AFFILIATE_DISCLOSURE_HTML}`;
    expect(
      withAmazonAffiliateDisclosure({
        content,
        enableAmazonAffiliateDisclosure: true,
        stores: [AMAZON_STORE],
      }),
    ).toBe(content);
  });
});
