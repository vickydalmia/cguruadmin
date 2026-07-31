import { describe, expect, it } from 'vitest';
import {
  entityPublicIdentityChanged,
  isPopularSearchEntityUid,
} from './popular-search-invalidation';

describe('Popular Searches ISR decisions', () => {
  it('recognises exactly the four entity-page UIDs', () => {
    expect(isPopularSearchEntityUid('api::store.store')).toBe(true);
    expect(isPopularSearchEntityUid('api::brand.brand')).toBe(true);
    expect(isPopularSearchEntityUid('api::category.category')).toBe(true);
    expect(isPopularSearchEntityUid('api::bank.bank')).toBe(true);
    expect(isPopularSearchEntityUid('api::coupon.coupon')).toBe(false);
    expect(isPopularSearchEntityUid('api::deal.deal')).toBe(false);
  });

  it('globally refreshes only actual entity name or slug changes', () => {
    expect(
      entityPublicIdentityChanged(
        { name: 'Amazon', slug: 'amazon' },
        { name: 'Amazon', slug: 'amazon' },
      ),
    ).toBe(false);
    expect(
      entityPublicIdentityChanged(
        { name: 'Amazon', slug: 'amazon' },
        { name: 'Amazon India', slug: 'amazon' },
      ),
    ).toBe(true);
    expect(entityPublicIdentityChanged(null, { name: 'A', slug: 'a' })).toBe(
      false,
    );
  });
});
