import { describe, expect, it } from 'vitest';

import {
  clearAffiliateState,
  dedupeBrandRefs,
  getAffiliateState,
  publishAffiliateState,
} from './affiliate-state';

describe('dedupeBrandRefs', () => {
  it('keeps pairs intact when a documentId repeats', () => {
    // The paginated relation load can return a row twice; deduplicating ids
    // and names SEPARATELY would label Y with X's name.
    expect(
      dedupeBrandRefs([
        { documentId: 'x', name: 'X' },
        { documentId: 'x', name: 'X' },
        { documentId: 'y', name: 'Y' },
      ]),
    ).toEqual([
      { documentId: 'x', name: 'X' },
      { documentId: 'y', name: 'Y' },
    ]);
  });

  it('keeps the FIRST occurrence of a duplicated id', () => {
    expect(
      dedupeBrandRefs([
        { documentId: 'x', name: 'first' },
        { documentId: 'x', name: 'second' },
      ]),
    ).toEqual([{ documentId: 'x', name: 'first' }]);
  });

  it('passes an already-unique list through unchanged', () => {
    const refs = [
      { documentId: 'a', name: 'A' },
      { documentId: 'b', name: 'B' },
    ];
    expect(dedupeBrandRefs(refs)).toEqual(refs);
  });
});

describe('affiliate entry state store', () => {
  it('keys states by model and documentId, treating undefined as "new"', () => {
    const state = {
      blocked: true,
      brandNames: ['X'],
      brandRefs: [{ documentId: 'x', name: 'X' }],
    };
    publishAffiliateState('api::coupon.coupon', 'doc-1', state);
    expect(getAffiliateState('api::coupon.coupon', 'doc-1')).toEqual(state);
    expect(getAffiliateState('api::coupon.coupon', undefined)).toBeUndefined();
    clearAffiliateState('api::coupon.coupon', 'doc-1');
    expect(getAffiliateState('api::coupon.coupon', 'doc-1')).toBeUndefined();
  });
});
