import { describe, expect, it } from 'vitest';
import { festivalSlideTitle } from './slide-title';
describe('Festival slide editor title', () => {
  it('shows a newly selected Coupon immediately', () => {
    expect(festivalSlideTitle('', { connect: [{ id: 2, label: 'New offer' }] }, [{ id: 1, title: 'Old offer' }])).toBe('New offer');
  });
  it('resolves the saved relation after reopening without an override', () => {
    expect(festivalSlideTitle(undefined, { connect: [], disconnect: [] }, [{ title: 'Saved Coupon title' }])).toBe('Saved Coupon title');
  });
  it('uses an explicit override and falls back when cleared', () => {
    expect(festivalSlideTitle('Custom title', {}, [{ title: 'Coupon' }])).toBe('Custom title');
    expect(festivalSlideTitle('  ', {}, [{ title: 'Coupon' }])).toBe('Coupon');
  });
  it('does not retain the title of a removed relation', () => {
    expect(festivalSlideTitle('', { disconnect: [{ id: 1 }] }, [{ id: 1, title: 'Removed' }])).toBe('Select a Coupon');
  });
});

it('uses the selected category name without filling a label override', () => {
  expect(festivalSlideTitle('', { connect: [{ documentId: 'category', name: 'Travel' }] }, [], 'Select a Category')).toBe('Travel');
  expect(festivalSlideTitle('', undefined, [{ documentId: 'category', name: 'Travel' }], 'Select a Category')).toBe('Travel');
  expect(festivalSlideTitle('', undefined, [], 'Select a Category')).toBe('Select a Category');
});
