import { describe, expect, it } from 'vitest';

import { ENTITY_ORDERED_COUPON_MAX } from '../../../utils/entity-ordered-coupon-validation';
import {
  ENTITY_TOP_PICK_COUPON_MAX,
  ENTITY_TOP_PICK_UIDS,
} from '../../../utils/entity-top-pick-validation';
import {
  COUPON_LAYOUT_CONFIG,
  ORDERED_MAX,
  TOP_PICK_DISPLAYED,
  TOP_PICK_MAX,
  couponLayoutConfig,
} from './config';

/**
 * The dialog duplicates the server's limits so the admin bundle stays free of
 * server-only modules. If a limit ever moves, the picker would silently let
 * editors build a selection the server then rejects — with the whole save.
 */
describe('coupon layout limits mirror the server', () => {
  it('matches the Top Pick maximum', () => {
    expect(TOP_PICK_MAX).toBe(ENTITY_TOP_PICK_COUPON_MAX);
  });

  it('displays fewer Top Picks than it accepts, so buffers exist', () => {
    // The gap between these two is what an expiry buffer is. If they were ever
    // equal, the buffer concept — and the rule letting buffers also be
    // ordered — would silently stop meaning anything.
    expect(TOP_PICK_DISPLAYED).toBeLessThan(TOP_PICK_MAX);
  });

  it('matches the Ordered Coupon maximum', () => {
    expect(ORDERED_MAX).toBe(ENTITY_ORDERED_COUPON_MAX);
  });

  it('covers exactly the entities that support curated Coupons', () => {
    expect(Object.keys(COUPON_LAYOUT_CONFIG).sort()).toEqual(
      [...ENTITY_TOP_PICK_UIDS].sort(),
    );
  });

  it('scopes each entity to its own Coupon relation', () => {
    expect(couponLayoutConfig('api::store.store')).toMatchObject({
      scopeRelationField: 'stores',
      publicPath: 'stores',
      publicEntityKey: 'store',
    });
    expect(couponLayoutConfig('api::category.category')).toMatchObject({
      scopeRelationField: 'categories',
      publicPath: 'categories',
      publicEntityKey: 'category',
    });
  });

  it('returns null for a model without curated Coupons', () => {
    expect(couponLayoutConfig('api::coupon.coupon')).toBeNull();
  });
});
