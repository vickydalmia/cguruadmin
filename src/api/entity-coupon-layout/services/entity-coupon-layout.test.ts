import { describe, expect, it } from 'vitest';
import {
  CouponLayoutError,
  ENTITY_COUPON_LAYOUT_ACTION,
  ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
  parseLayoutSelection,
} from './entity-coupon-layout';

describe('entity Coupon layout selection contract', () => {
  it('registers as a core Administration Panel settings action', () => {
    expect(ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES).toMatchObject({
      section: 'settings',
      pluginName: 'admin',
      uid: 'entity-coupon-layout.manage',
    });
    expect(ENTITY_COUPON_LAYOUT_ACTION).toBe(
      `admin::${ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES.uid}`,
    );
  });

  it('allows buffer overlap but rejects displayed Top Pick overlap', () => {
    expect(
      parseLayoutSelection({
        topPickCouponIds: ['a', 'b', 'c'],
        orderedCouponIds: ['c', 'd'],
      }),
    ).toEqual({
      topPickCouponIds: ['a', 'b', 'c'],
      orderedCouponIds: ['c', 'd'],
    });
    expect(() =>
      parseLayoutSelection({
        topPickCouponIds: ['a', 'b', 'c'],
        orderedCouponIds: ['b'],
      }),
    ).toThrowError(CouponLayoutError);
  });

  it('rejects duplicates and limits before any write', () => {
    expect(() =>
      parseLayoutSelection({
        topPickCouponIds: ['a', 'a'],
        orderedCouponIds: [],
      }),
    ).toThrow(/same Coupon/);
    expect(() =>
      parseLayoutSelection({
        topPickCouponIds: [],
        orderedCouponIds: Array.from({ length: 11 }, (_, index) => `c${index}`),
      }),
    ).toThrow(/at most 10/);
  });
});
