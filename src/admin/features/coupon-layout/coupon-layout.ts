import { TOP_PICK_DISPLAYED } from './config';

export type CouponCandidate = {
  id: number;
  documentId: string;
  name: string;
  /**
   * 'code' when the Coupon carries a promo code, else 'no-code'. Null when the
   * source did not carry the fields to tell — the relations endpoint returns
   * little more than the main field, and rendering "NO CODE · no expiry" for a
   * Coupon we simply have not loaded would be worse than saying nothing.
   */
  offerType: 'code' | 'no-code' | null;
  badge: string | null;
  expiresAt: string | null;
  publishedOn: string | null;
  /** Whether the Coupon detail fields were present on the source record. */
  detailed: boolean;
};

/**
 * The Coupon schema stores `couponType` plus the code itself. A Coupon is a
 * code Coupon when it actually has a code to reveal — `couponType` alone is
 * unreliable for pool-backed entries that have not been filled yet.
 */
export function couponOfferType(raw: {
  code?: unknown;
  couponType?: unknown;
}): 'code' | 'no-code' {
  if (typeof raw.code === 'string' && raw.code.trim().length > 0) return 'code';
  return raw.couponType === 'unique' ? 'code' : 'no-code';
}

export function toCandidate(raw: any): CouponCandidate {
  // `couponType` is required on the Coupon schema, so its absence means the
  // record is a thin relation projection rather than a Coupon with no code.
  const detailed = typeof raw?.couponType === 'string';

  return {
    id: raw.id,
    documentId: raw.documentId,
    name: raw.title ?? raw.name ?? String(raw.id),
    offerType: detailed ? couponOfferType(raw) : null,
    badge: typeof raw?.badge === 'string' ? raw.badge : null,
    expiresAt: typeof raw?.expiresAt === 'string' ? raw.expiresAt : null,
    publishedOn:
      typeof raw?.publishedOn === 'string'
        ? raw.publishedOn
        : typeof raw?.publishedAt === 'string'
          ? raw.publishedAt
          : null,
    detailed,
  };
}

/**
 * Which Top Pick slots the storefront actually renders. Selections past the
 * first two are expiry buffers: they only become visible once an earlier
 * selection stops being live.
 */
export function topPickSlotRole(index: number): 'shown' | 'buffer' {
  return index < TOP_PICK_DISPLAYED ? 'shown' : 'buffer';
}

/**
 * Whether a candidate row's checkbox is disabled.
 *
 * Guards ADDING only. Disabling an already-selected row traps it: a Coupon
 * that is both a shown Top Pick and an Ordered Coupon is blocked in the
 * Ordered column, and disabling its uncheck made it impossible to remove from
 * that list at all — the selection looked editable but never persisted.
 */
export function candidateDisabled(state: {
  isSelected: boolean;
  /** Taken by the other list, where the two may not overlap. */
  isBlocked: boolean;
  atLimit: boolean;
  tooFewCoupons: boolean;
  /**
   * The persisted selection has not arrived yet. The candidate pool can load
   * first, so without this an editor can add to a list that still reads as
   * empty — the count, the limit check and the visible order would all be
   * computed against a selection nobody has seen.
   */
  selectionLoading: boolean;
}): boolean {
  if (state.selectionLoading) return true;
  if (state.isSelected) return false;
  return state.isBlocked || state.atLimit || state.tooFewCoupons;
}

export type PreviewRow = {
  documentId: string;
  name: string;
  /** 'ordered' rows come from the editorial head; 'automatic' from recency. */
  source: 'ordered' | 'automatic';
  /** True while the row reflects an edit that has not been saved yet. */
  pending: boolean;
};

/**
 * Build the resulting main-list sequence.
 *
 * `savedSequence` is the public endpoint's own output — the same response the
 * storefront consumes — so the ordering rules are never re-implemented here.
 * The only thing applied on top is the contract's one-line merge rule:
 * the selection leads in exact CMS order, everything else follows unchanged.
 *
 * That keeps unsaved edits previewable without duplicating any sort.
 *
 * `pendingOrdered` is null while the editor's selection is still loading. The
 * head is then taken from `savedOrderedIds` instead — the saved sequence
 * already leads with those, so the rows are identical either way, but they get
 * labelled as the editor's ordering rather than mislabelled "newest-first"
 * for as long as the relation request is in flight.
 */
export function buildPreviewRows(
  savedSequence: readonly CouponCandidate[],
  pendingOrdered: readonly CouponCandidate[] | null,
  savedOrderedIds: readonly string[],
  /**
   * Coupons rendered in the Top Pick section. The public endpoint returns the
   * entity's full Coupon membership — it does not subtract Top Picks — but the
   * storefront removes the displayed ones before rendering the main list.
   * Without this the preview showed them twice and claimed a main-list
   * position they never occupy.
   */
  displayedTopPickIds: readonly string[] = [],
): PreviewRow[] {
  const displayed = new Set(displayedTopPickIds);
  const resolvedOrdered =
    pendingOrdered ??
    savedOrderedIds.flatMap((id) => {
      const coupon = savedSequence.find(
        (candidate) => candidate.documentId === id,
      );
      return coupon ? [coupon] : [];
    });
  const pendingIds = new Set(
    resolvedOrdered.map((coupon) => coupon.documentId),
  );
  const savedIds = new Set(savedOrderedIds);
  const byId = new Map(
    savedSequence.map((coupon) => [coupon.documentId, coupon]),
  );
  // The saved head as it actually renders: minus selections that expired out
  // of the response, and minus displayed Top Picks. Both close the head up
  // without being editor edits. Filtered on the SAME terms as the head below,
  // or the positional comparison would drift by one and report every later row
  // as unsaved.
  const savedHead = savedOrderedIds.filter(
    (id) => byId.has(id) && !displayed.has(id),
  );

  const head: PreviewRow[] = resolvedOrdered
    // A displayed Top Pick is taken out of the main list, so the head closes
    // up around it exactly as the storefront's does.
    .filter((coupon) => !displayed.has(coupon.documentId))
    .map((coupon, index) => ({
      documentId: coupon.documentId,
      // Prefer the saved projection's title so the preview shows what the
      // public API will actually render, falling back to the picker's copy.
      name: byId.get(coupon.documentId)?.name ?? coupon.name,
      source: 'ordered' as const,
      // Compared by POSITION, not membership. A pure drag-reorder changes no
      // ids, so a membership test marked the whole new sequence as already
      // saved — the one edit this preview exists to show.
      pending: savedHead[index] !== coupon.documentId,
    }));

  const rest: PreviewRow[] = savedSequence
    .filter(
      (coupon) =>
        !pendingIds.has(coupon.documentId) &&
        !displayed.has(coupon.documentId),
    )
    .map((coupon) => ({
      documentId: coupon.documentId,
      name: coupon.name,
      source: 'automatic',
      // A Coupon dropped from the head moves into the automatic remainder,
      // which is also an unsaved change.
      pending: savedIds.has(coupon.documentId),
    }));

  return [...head, ...rest];
}
