import { describe, expect, it } from 'vitest';

import {
  affiliateBlockNote,
  affiliateCandidateBlocked,
  brandCandidateBlocked,
  plainCandidateBlocked,
  storeAddBlocked,
  storeBlockNote,
} from './affiliate-exclusion';

const MERCHANT_STORE = { kind: 'store', documentId: 'store-1' } as const;
const MERCHANT_SELF = { kind: 'brand', documentId: 'brand-aff' } as const;
const MERCHANT_OTHER = { kind: 'brand', documentId: 'brand-other' } as const;

const freeAffiliate = {
  isSelected: false,
  storeCount: 0,
  storesReady: true,
  selectedBrandCount: 0,
  brandsReady: true,
  merchant: null,
  candidateDocumentId: 'brand-aff',
};

describe('affiliateCandidateBlocked', () => {
  it('allows an affiliate brand on an empty offer', () => {
    expect(affiliateCandidateBlocked(freeAffiliate)).toBe(false);
  });

  it('never blocks an already-selected row', () => {
    expect(
      affiliateCandidateBlocked({
        ...freeAffiliate,
        isSelected: true,
        storeCount: 1,
        selectedBrandCount: 2,
        merchant: MERCHANT_STORE,
      }),
    ).toBe(false);
  });

  it('blocks while the stores section is still loading', () => {
    expect(
      affiliateCandidateBlocked({ ...freeAffiliate, storesReady: false }),
    ).toBe(true);
  });

  it('blocks while its own persisted brands are still loading', () => {
    // The stored row may already hold another brand the count cannot see yet.
    expect(
      affiliateCandidateBlocked({ ...freeAffiliate, brandsReady: false }),
    ).toBe(true);
  });

  it('blocks when a Store is selected', () => {
    expect(affiliateCandidateBlocked({ ...freeAffiliate, storeCount: 1 })).toBe(
      true,
    );
  });

  it('blocks when any other brand is selected', () => {
    expect(
      affiliateCandidateBlocked({ ...freeAffiliate, selectedBrandCount: 1 }),
    ).toBe(true);
  });

  it('blocks when the checkout merchant points at a store', () => {
    expect(
      affiliateCandidateBlocked({ ...freeAffiliate, merchant: MERCHANT_STORE }),
    ).toBe(true);
  });

  it('blocks when the checkout merchant points at a different brand', () => {
    expect(
      affiliateCandidateBlocked({ ...freeAffiliate, merchant: MERCHANT_OTHER }),
    ).toBe(true);
  });

  it('allows a checkout merchant pointing at the candidate itself', () => {
    expect(
      affiliateCandidateBlocked({ ...freeAffiliate, merchant: MERCHANT_SELF }),
    ).toBe(false);
  });
});

const plainFree = {
  isSelected: false,
  brandsReady: true,
  affiliateFlagsReady: true,
  affiliateSelectedCount: 0,
};

describe('plainCandidateBlocked', () => {
  it('allows plain brands to mix freely once state is known', () => {
    expect(plainCandidateBlocked(plainFree)).toBe(false);
  });

  it('never blocks an already-selected row', () => {
    expect(
      plainCandidateBlocked({
        ...plainFree,
        isSelected: true,
        affiliateSelectedCount: 1,
      }),
    ).toBe(false);
  });

  it('blocks when an affiliate brand is selected', () => {
    expect(
      plainCandidateBlocked({ ...plainFree, affiliateSelectedCount: 1 }),
    ).toBe(true);
  });

  it('fails safe while brand state is unknown, even with zero known brands', () => {
    // Before the section's first report the count reads 0 while the stored
    // row may hold an affiliate brand — unknown blocks unconditionally.
    expect(
      plainCandidateBlocked({ ...plainFree, affiliateFlagsReady: false }),
    ).toBe(true);
    expect(plainCandidateBlocked({ ...plainFree, brandsReady: false })).toBe(
      true,
    );
  });
});

describe('brandCandidateBlocked', () => {
  const knownCandidate = {
    ...freeAffiliate,
    isAffiliate: false,
    affiliateFlagsReady: true,
    affiliateSelectedCount: 0,
  };

  it('allows an explicitly plain Brand once the relation state is known', () => {
    expect(brandCandidateBlocked(knownCandidate)).toBe(false);
  });

  it('routes an explicitly affiliate Brand through the exclusivity checks', () => {
    expect(
      brandCandidateBlocked({
        ...knownCandidate,
        isAffiliate: true,
        storeCount: 1,
      }),
    ).toBe(true);
  });

  it('fails safe when the candidate affiliate flag is unavailable', () => {
    expect(
      brandCandidateBlocked({ ...knownCandidate, isAffiliate: undefined }),
    ).toBe(true);
    expect(
      brandCandidateBlocked({ ...knownCandidate, isAffiliate: null }),
    ).toBe(true);
  });

  it('keeps an unresolved selected row removable', () => {
    expect(
      brandCandidateBlocked({
        ...knownCandidate,
        isSelected: true,
        isAffiliate: undefined,
      }),
    ).toBe(false);
  });
});

describe('storeAddBlocked', () => {
  const free = {
    brandsReady: true,
    affiliateFlagsReady: true,
    affiliateSelectedCount: 0,
  };

  it('allows a store once brand state is known and non-affiliate', () => {
    expect(storeAddBlocked(free)).toBe(false);
  });

  it('blocks when an affiliate brand is selected', () => {
    expect(storeAddBlocked({ ...free, affiliateSelectedCount: 1 })).toBe(true);
  });

  it('fails safe while brand state is unknown, even with zero known brands', () => {
    expect(storeAddBlocked({ ...free, affiliateFlagsReady: false })).toBe(true);
    expect(storeAddBlocked({ ...free, brandsReady: false })).toBe(true);
  });
});

describe('notes', () => {
  it('explains the affiliate-selected state with names', () => {
    expect(
      affiliateBlockNote({
        storeCount: 0,
        selectedBrandCount: 1,
        affiliateSelectedNames: ['AffBrand'],
      }),
    ).toContain('AffBrand');
    expect(storeBlockNote({ affiliateSelectedNames: ['AffBrand'] })).toContain(
      'AffBrand',
    );
  });

  it('explains the store-selected state', () => {
    expect(
      affiliateBlockNote({
        storeCount: 1,
        selectedBrandCount: 0,
        affiliateSelectedNames: [],
      }),
    ).toContain('Store is selected');
  });

  it('stays silent when nothing blocks', () => {
    expect(
      affiliateBlockNote({
        storeCount: 0,
        selectedBrandCount: 0,
        affiliateSelectedNames: [],
      }),
    ).toBeNull();
    expect(storeBlockNote({ affiliateSelectedNames: [] })).toBeNull();
  });
});
