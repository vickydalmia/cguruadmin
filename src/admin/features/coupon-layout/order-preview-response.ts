import { toCandidate, type CouponCandidate } from './coupon-layout';

export type OrderPreviewSource = {
  /** The saved main-list sequence exactly as the public endpoint returns it. */
  sequence: CouponCandidate[];
  /**
   * The Coupons the backend will actually display as Top Picks, already
   * including any automatic fill. Taken verbatim from the response — the
   * client must NOT re-derive it (see below).
   */
  displayedTopPicks: CouponCandidate[];
  /** documentIds currently persisted in `orderedCoupons`. */
  savedOrderedIds: string[];
  total: number;
  loading: boolean;
  /** Set when the entity has no saved slug yet, or the request failed. */
  error: string | null;
};

/**
 * Map the preview response.
 *
 * `displayedTopPicks` comes straight from `body.topPicks`. The backend already
 * fills empty Top Pick slots from the automatic pool and then EXCLUDES those
 * Coupons from `body.coupons`. Re-deriving the fill on the client from that
 * already-filtered list therefore picked the wrong Coupons — the genuinely
 * displayed ones vanished from the preview entirely and the next two down were
 * shown in a section they will never render in.
 *
 * `savedOrderedIds` must be the PERSISTED ids, not the pending selection. It
 * is what the "unsaved" markers are diffed against, so passing the pending
 * list compared it with itself and no row could ever be marked.
 */
export function orderPreviewSourceFromResponse(
  body: any,
  savedOrderedIds: readonly string[],
): OrderPreviewSource {
  return {
    sequence: (Array.isArray(body?.coupons) ? body.coupons : []).map(
      toCandidate,
    ),
    displayedTopPicks: (Array.isArray(body?.topPicks) ? body.topPicks : []).map(
      toCandidate,
    ),
    savedOrderedIds: [...savedOrderedIds],
    total: Number(body?.total) || 0,
    loading: false,
    error: null,
  };
}
