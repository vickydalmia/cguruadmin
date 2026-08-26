import { describe, expect, it } from 'vitest';
import {
  mergeDescendingRelationPage,
  removalNeedsDisconnect,
} from './ordered-relation';

const candidate = (documentId: string, id: number) => ({
  id,
  documentId,
  name: documentId,
});

describe('mergeDescendingRelationPage', () => {
  it('restores the persisted order from one descending API page', () => {
    const apiPage = [
      candidate('coupon-c', 3),
      candidate('coupon-b', 2),
      candidate('coupon-a', 1),
    ];

    expect(
      mergeDescendingRelationPage([], apiPage).map((item) => item.documentId),
    ).toEqual(['coupon-a', 'coupon-b', 'coupon-c']);
  });

  it('prepends later descending pages like Strapi native relation inputs', () => {
    const firstApiPage = [
      candidate('coupon-d', 4),
      candidate('coupon-c', 3),
    ];
    const secondApiPage = [
      candidate('coupon-b', 2),
      candidate('coupon-a', 1),
    ];

    const first = mergeDescendingRelationPage([], firstApiPage);
    const all = mergeDescendingRelationPage(first, secondApiPage);

    expect(all.map((item) => item.documentId)).toEqual([
      'coupon-a',
      'coupon-b',
      'coupon-c',
      'coupon-d',
    ]);
  });
});
describe('removalNeedsDisconnect', () => {
  it('still disconnects a persisted item after reorder reconnects every row', () => {
    const persisted = new Set(['coupon-a', 'coupon-b', 'coupon-c']);

    expect(removalNeedsDisconnect(persisted, 'coupon-c', false)).toBe(true);
    expect(
      removalNeedsDisconnect(persisted, 'coupon-c', true),
    ).toBe(true);
    expect(
      removalNeedsDisconnect(persisted, 'new-unsaved-coupon', true),
    ).toBe(false);
  });
});
