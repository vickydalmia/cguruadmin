import { describe, expect, it } from 'vitest';

import {
  buildPreviewRows,
  candidateDisabled,
  couponOfferType,
  toCandidate,
  topPickSlotRole,
  type CouponCandidate,
} from './coupon-layout';

const coupon = (documentId: string): CouponCandidate => ({
  id: Number(documentId.replace(/\D/g, '')) || 1,
  documentId,
  name: `Coupon ${documentId}`,
  offerType: 'code',
  badge: null,
  expiresAt: null,
  publishedOn: null,
  detailed: true,
});

describe('toCandidate', () => {
  it('reads the detail fields from a full Coupon record', () => {
    expect(
      toCandidate({
        id: 7,
        documentId: 'doc-7',
        title: 'Flat 10% Off',
        couponType: 'static',
        code: 'TEN',
        badge: 'Recommended',
        expiresAt: '2026-08-01T00:00:00.000Z',
        publishedOn: '2026-07-01T00:00:00.000Z',
      }),
    ).toEqual({
      id: 7,
      documentId: 'doc-7',
      name: 'Flat 10% Off',
      offerType: 'code',
      badge: 'Recommended',
      expiresAt: '2026-08-01T00:00:00.000Z',
      publishedOn: '2026-07-01T00:00:00.000Z',
      detailed: true,
    });
  });

  it('does not claim a thin relation projection is a no-code Coupon', () => {
    // The relations endpoint returns little more than the main field. Guessing
    // "NO CODE · no expiry" here would mislabel a code Coupon.
    const candidate = toCandidate({
      id: 7,
      documentId: 'doc-7',
      title: 'Flat 10% Off',
    });

    expect(candidate.offerType).toBeNull();
    expect(candidate.detailed).toBe(false);
  });

  it('falls back to publishedAt, then the id, for display', () => {
    expect(
      toCandidate({ id: 3, documentId: 'd', publishedAt: '2026-07-02T00:00:00.000Z' }),
    ).toMatchObject({ name: '3', publishedOn: '2026-07-02T00:00:00.000Z' });
  });
});

describe('couponOfferType', () => {
  it('treats a filled static code as a code Coupon', () => {
    expect(couponOfferType({ couponType: 'static', code: 'SAVE50' })).toBe('code');
  });

  it('treats a static Coupon with no code as no-code', () => {
    expect(couponOfferType({ couponType: 'static', code: '   ' })).toBe('no-code');
    expect(couponOfferType({ couponType: 'static' })).toBe('no-code');
  });

  it('treats a unique-pool Coupon as a code Coupon before the pool is filled', () => {
    expect(couponOfferType({ couponType: 'unique' })).toBe('code');
  });
});

describe('topPickSlotRole', () => {
  it('marks the first two slots shown and the rest expiry buffers', () => {
    expect([0, 1, 2, 3].map(topPickSlotRole)).toEqual([
      'shown',
      'shown',
      'buffer',
      'buffer',
    ]);
  });
});

describe('candidateDisabled', () => {
  const base = {
    isSelected: false,
    isBlocked: false,
    atLimit: false,
    tooFewCoupons: false,
    selectionLoading: false,
  };

  it('disables everything until the persisted selection has arrived', () => {
    // The candidate pool can load first. Adding against a selection that still
    // reads as empty computes the count, the limit check and the order from a
    // selection nobody has seen.
    expect(
      candidateDisabled({ ...base, selectionLoading: true }),
    ).toBe(true);
    expect(
      candidateDisabled({
        ...base,
        isSelected: true,
        selectionLoading: true,
      }),
    ).toBe(true);
  });

  it('never disables an already-selected Coupon', () => {
    // The bug this pins: a Coupon that is both a shown Top Pick and an Ordered
    // Coupon is blocked in the Ordered column. Disabling its uncheck made it
    // impossible to remove — the list looked editable but never persisted.
    expect(
      candidateDisabled({
        isSelected: true,
        isBlocked: true,
        atLimit: true,
        tooFewCoupons: true,
        selectionLoading: false,
      }),
    ).toBe(false);
  });

  it('blocks adding a Coupon the other list has taken', () => {
    expect(candidateDisabled({ ...base, isBlocked: true })).toBe(true);
  });

  it('blocks adding at the selection limit', () => {
    expect(candidateDisabled({ ...base, atLimit: true })).toBe(true);
  });

  it('blocks adding when the entry has too few live Coupons', () => {
    expect(candidateDisabled({ ...base, tooFewCoupons: true })).toBe(true);
  });

  it('allows adding otherwise', () => {
    expect(candidateDisabled(base)).toBe(false);
  });
});

describe('buildPreviewRows', () => {
  const saved = [coupon('a'), coupon('b'), coupon('c'), coupon('d')];

  it('mirrors the saved sequence when nothing is pending', () => {
    const rows = buildPreviewRows(saved, [coupon('a')], ['a']);

    expect(rows.map((row) => row.documentId)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((row) => row.source)).toEqual([
      'ordered',
      'automatic',
      'automatic',
      'automatic',
    ]);
    expect(rows.some((row) => row.pending)).toBe(false);
  });

  it('lifts an unsaved selection to the head and flags it', () => {
    const rows = buildPreviewRows(saved, [coupon('c'), coupon('a')], []);

    expect(rows.map((row) => row.documentId)).toEqual(['c', 'a', 'b', 'd']);
    expect(rows.filter((row) => row.pending).map((row) => row.documentId)).toEqual([
      'c',
      'a',
    ]);
  });

  it('flags a Coupon dropped from the head back into the remainder', () => {
    const rows = buildPreviewRows(saved, [], ['a']);

    expect(rows.map((row) => row.documentId)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows[0]).toMatchObject({ source: 'automatic', pending: true });
    expect(rows[1]).toMatchObject({ source: 'automatic', pending: false });
  });

  it('reorders the head without touching the automatic remainder', () => {
    const rows = buildPreviewRows(saved, [coupon('b'), coupon('a')], ['a', 'b']);

    expect(rows.map((row) => row.documentId)).toEqual(['b', 'a', 'c', 'd']);
    expect(rows.slice(2).every((row) => row.source === 'automatic')).toBe(true);
  });

  it('marks a pure drag-reorder as unsaved', () => {
    // A reorder changes no ids, so testing membership reported the whole new
    // sequence as already saved — the one edit this preview exists to show.
    const rows = buildPreviewRows(saved, [coupon('b'), coupon('a')], ['a', 'b']);

    expect(rows.slice(0, 2).map((row) => row.pending)).toEqual([true, true]);
    expect(rows.slice(2).some((row) => row.pending)).toBe(false);
  });

  it('leaves an unmoved head unmarked', () => {
    const rows = buildPreviewRows(saved, [coupon('a'), coupon('b')], ['a', 'b']);

    expect(rows.some((row) => row.pending)).toBe(false);
  });

  it('does not mark the head unsaved when an expired selection closed up', () => {
    // 'gone' is still in the saved relation but absent from the response, so
    // 'b' legitimately leads. That is the cleanup job's doing, not an edit.
    const rows = buildPreviewRows(saved, [coupon('b')], ['gone', 'b']);

    expect(rows[0]).toMatchObject({ documentId: 'b', source: 'ordered' });
    expect(rows[0]!.pending).toBe(false);
  });

  it('labels the saved head as ordered while the selection is still loading', () => {
    // The rows were in the right positions but every one of them was tagged
    // "newest-first", because the head was derived solely from the in-flight
    // selection. The saved ids already identify them.
    const rows = buildPreviewRows(saved, null, ['a', 'b']);

    expect(rows.map((row) => row.documentId)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((row) => row.source)).toEqual([
      'ordered',
      'ordered',
      'automatic',
      'automatic',
    ]);
    expect(rows.some((row) => row.pending)).toBe(false);
  });

  it('does not confuse a loading selection with a deliberately empty one', () => {
    const loading = buildPreviewRows(saved, null, ['a']);
    const cleared = buildPreviewRows(saved, [], ['a']);

    expect(loading[0]).toMatchObject({ source: 'ordered', pending: false });
    // Cleared is a real edit: 'a' drops into the remainder, unsaved.
    expect(cleared[0]).toMatchObject({ source: 'automatic', pending: true });
  });

  it('ignores a saved id the response no longer contains', () => {
    const rows = buildPreviewRows(saved, null, ['gone', 'b']);

    expect(rows.map((row) => row.documentId)).toEqual(['b', 'a', 'c', 'd']);
    expect(rows[0]).toMatchObject({ source: 'ordered' });
  });

  it('keeps a pending selection the saved response has not seen yet', () => {
    // A Coupon just added to the head is absent from the saved sequence until
    // the next save, so it must still render rather than vanish.
    const rows = buildPreviewRows(saved, [coupon('new')], []);

    expect(rows.map((row) => row.documentId)).toEqual([
      'new',
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(rows[0]).toMatchObject({ name: 'Coupon new', pending: true });
  });
});

describe('buildPreviewRows excludes displayed Top Picks', () => {
  const saved = [coupon('a'), coupon('b'), coupon('c'), coupon('d')];

  it('keeps a displayed Top Pick out of the main list', () => {
    // The public endpoint returns the entity's full membership; the storefront
    // subtracts the displayed Top Picks before rendering the main list. Without
    // this the preview showed them in both sections.
    const rows = buildPreviewRows(saved, [], [], ['b']);

    expect(rows.map((row) => row.documentId)).toEqual(['a', 'c', 'd']);
  });

  it('closes the ordered head up around a displayed Top Pick', () => {
    const rows = buildPreviewRows(
      saved,
      [coupon('a'), coupon('b'), coupon('c')],
      ['a', 'b', 'c'],
      ['b'],
    );

    expect(rows.map((row) => row.documentId)).toEqual(['a', 'c', 'd']);
    expect(rows.slice(0, 2).map((row) => row.source)).toEqual([
      'ordered',
      'ordered',
    ]);
    // Both sides of the position comparison drop 'b', so nothing downstream
    // drifts into looking unsaved.
    expect(rows.some((row) => row.pending)).toBe(false);
  });

  it('is unchanged when no Top Pick is displayed', () => {
    expect(buildPreviewRows(saved, [], [], []).map((r) => r.documentId)).toEqual(
      ['a', 'b', 'c', 'd'],
    );
  });
});
