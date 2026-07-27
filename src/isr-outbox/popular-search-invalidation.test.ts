import { describe, expect, it } from 'vitest';
import {
  affectsPopularSearchInventory,
  entityPublicIdentityChanged,
} from './popular-search-invalidation';

describe('Popular Searches ISR decisions', () => {
  it('keeps ordinary offer content edits targeted', () => {
    expect(
      affectsPopularSearchInventory('api::coupon.coupon', 'update', {
        title: 'New copy',
      }),
    ).toBe(false);
    expect(
      affectsPopularSearchInventory('api::deal.deal', 'update', {
        brands: { connect: ['brand-1'] },
      }),
    ).toBe(true);
    expect(
      affectsPopularSearchInventory('api::coupon.coupon', 'update', {
        contentStatus: 'expired',
      }),
    ).toBe(true);
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
  });
});
