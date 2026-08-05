import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_MERCHANT_CUSTOM_FIELD_UID,
  CHECKOUT_MERCHANT_MAX_LENGTH,
  CHECKOUT_MERCHANT_SOURCES,
  checkoutMerchantSource,
  formatCheckoutMerchant,
  isBlankCheckoutMerchant,
  isCheckoutMerchantOfferUid,
  parseCheckoutMerchant,
} from './checkout-merchant';

describe('the custom field uid', () => {
  it('matches what both schema.json files declare', () => {
    // A drift here does not fail a test elsewhere — it fails BOOT, in
    // convertCustomFieldType, with "Could not find Custom Field". Pin it.
    expect(CHECKOUT_MERCHANT_CUSTOM_FIELD_UID).toBe('global::checkout-merchant');
  });
});

describe('isCheckoutMerchantOfferUid', () => {
  it('matches only the two offer types', () => {
    expect(isCheckoutMerchantOfferUid('api::coupon.coupon')).toBe(true);
    expect(isCheckoutMerchantOfferUid('api::deal.deal')).toBe(true);
    expect(isCheckoutMerchantOfferUid('api::store.store')).toBe(false);
    expect(isCheckoutMerchantOfferUid(null)).toBe(false);
  });
});

describe('checkoutMerchantSource', () => {
  it('maps each kind to its content type', () => {
    expect(checkoutMerchantSource('store').target).toBe('api::store.store');
    expect(checkoutMerchantSource('brand').target).toBe('api::brand.brand');
  });

  it('lists Stores before Brands', () => {
    // The picker appends each source's page independently and never re-sorts
    // the merged list, so this order IS the rendered order.
    expect(CHECKOUT_MERCHANT_SOURCES.map((source) => source.kind)).toEqual([
      'store',
      'brand',
    ]);
  });
});

describe('formatCheckoutMerchant / parseCheckoutMerchant', () => {
  it('round-trips both kinds', () => {
    for (const kind of ['store', 'brand'] as const) {
      const ref = { kind, documentId: 'abc123xyz789' };
      expect(parseCheckoutMerchant(formatCheckoutMerchant(ref))).toEqual(ref);
    }
  });

  it('produces a value inside the column cap', () => {
    const value = formatCheckoutMerchant({
      kind: 'brand',
      documentId: 'a'.repeat(40),
    });
    expect(value.length).toBeLessThanOrEqual(CHECKOUT_MERCHANT_MAX_LENGTH);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseCheckoutMerchant('  store:abc123  ')).toEqual({
      kind: 'store',
      documentId: 'abc123',
    });
  });

  it('rejects an unknown kind', () => {
    expect(parseCheckoutMerchant('bank:abc123')).toBeNull();
    expect(parseCheckoutMerchant('category:abc123')).toBeNull();
  });

  it('rejects a missing or empty half', () => {
    expect(parseCheckoutMerchant('store')).toBeNull();
    expect(parseCheckoutMerchant('store:')).toBeNull();
    expect(parseCheckoutMerchant(':abc123')).toBeNull();
  });

  it('rejects a documentId containing the delimiter', () => {
    // The split takes the FIRST colon, so a second one would silently land
    // inside the id. Reject rather than store an id nothing can look up.
    expect(parseCheckoutMerchant('store:abc:123')).toBeNull();
  });

  it('rejects blank and non-string values', () => {
    for (const value of ['', '   ', null, undefined, 42, {}, ['store:a']]) {
      expect(parseCheckoutMerchant(value)).toBeNull();
    }
  });
});

describe('isBlankCheckoutMerchant', () => {
  it('separates "no merchant" from "a bad merchant"', () => {
    // Both parse to null, but only the first is allowed to save silently.
    expect(isBlankCheckoutMerchant(null)).toBe(true);
    expect(isBlankCheckoutMerchant(undefined)).toBe(true);
    expect(isBlankCheckoutMerchant('   ')).toBe(true);
    expect(isBlankCheckoutMerchant('bank:abc')).toBe(false);
  });
});
