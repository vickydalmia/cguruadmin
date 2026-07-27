import { describe, expect, it } from 'vitest';
import {
  mergeDescendingRelationPage,
  orderedRelationCommands,
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

describe('orderedRelationCommands', () => {
  it('rebuilds anchors from the remaining selection after an item is removed', () => {
    const reordered = [
      candidate('coupon-a', 1),
      candidate('coupon-c', 3),
      candidate('coupon-b', 2),
    ];
    const remaining = reordered.filter(
      (item) => item.documentId !== 'coupon-c',
    );

    const commands = orderedRelationCommands(remaining);

    expect(commands.map((command) => command.documentId)).toEqual([
      'coupon-b',
      'coupon-a',
    ]);
    expect(commands[0]?.apiData.position).toEqual({ end: true });
    expect(commands[1]?.apiData.position).toEqual({
      before: 'coupon-b',
      status: 'published',
      locale: null,
    });
    expect(JSON.stringify(commands)).not.toContain('coupon-c');
  });

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

  it('rebuilds the full chain when a disconnected item is selected again', () => {
    const couponA = candidate('coupon-a', 1);
    const couponB = candidate('coupon-b', 2);

    // Removing B temporarily leaves A as the tail.
    expect(orderedRelationCommands([couponA])[0]?.apiData.position).toEqual({
      end: true,
    });

    // Re-selecting B must replace that shortened command set completely.
    const restored = orderedRelationCommands([couponA, couponB]);
    expect(restored.map((command) => command.documentId)).toEqual([
      'coupon-b',
      'coupon-a',
    ]);
    expect(restored[0]?.apiData.position).toEqual({ end: true });
    expect(restored[1]?.apiData.position).toEqual({
      before: 'coupon-b',
      status: 'published',
      locale: null,
    });
  });
});
