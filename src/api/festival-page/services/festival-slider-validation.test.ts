import { describe, expect, it } from 'vitest';
import { festivalSlideProblems } from './festival-slider-validation';

describe('Festival Coupon slide relations', () => {
  it('reports every missing or multiple selection on its slide field', () => {
    expect(festivalSlideProblems({ items: [{}, { coupon: { set: [3, 4] } }] }, null).map((error) => error.path)).toEqual([
      ['offerSlider', 'items', 0, 'coupon'], ['offerSlider', 'items', 1, 'coupon'],
    ]);
  });
  it('resolves relation patches against component ids, including reordered partial edits', () => {
    const stored = { items: [{ id: 9, coupon: { documentId: 'coupon-a', id: 1 } }, { id: 10, coupon: { id: 2 } }] };
    expect(festivalSlideProblems({ items: [{ id: 10 }, { id: 9, titleOverride: 'New title', coupon: { connect: [], disconnect: [] } }] }, stored)).toEqual([]);
    expect(festivalSlideProblems({ items: [{ id: 9, coupon: { disconnect: [{ documentId: 'coupon-a' }] } }] }, stored)[0].path).toEqual(['offerSlider', 'items', 0, 'coupon']);
    expect(festivalSlideProblems({ items: [{ id: 9, coupon: { set: ['coupon-b'] } }] }, stored)).toEqual([]);
    expect(festivalSlideProblems({ items: [{ id: 9, coupon: null }] }, stored)).toHaveLength(1);
  });
  it('allows removing the section or all slides without creating defaults', () => {
    expect(festivalSlideProblems(null, null)).toEqual([]);
    expect(festivalSlideProblems({ items: [] }, null)).toEqual([]);
  });
});
