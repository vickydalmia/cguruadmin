import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';

import { toCandidate, type CouponCandidate } from './coupon-layout';
import type { CouponLayoutConfig } from './config';

/** Enough rows to show the head plus a useful stretch of the remainder. */
const PREVIEW_PAGE_SIZE = 30;

export type OrderPreviewSource = {
  /** The saved main-list sequence exactly as the public endpoint returns it. */
  sequence: CouponCandidate[];
  /** documentIds currently persisted in `orderedCoupons`. */
  savedOrderedIds: string[];
  total: number;
  loading: boolean;
  /** Set when the entity has no saved slug yet, or the request failed. */
  error: string | null;
};

/**
 * Read the resulting order from the SAME endpoint the storefront consumes.
 *
 * The admin deliberately does not re-derive the ordering rules — the head/
 * remainder merge lives in listEntityOffers (src/api/coupon/controllers/
 * custom.ts) and would drift if it were reimplemented here. Only the
 * contract's one-line merge rule is applied on top, so unsaved edits still
 * preview. See buildPreviewRows.
 *
 * Note this cannot render the real page: entity pages are served exclusively
 * from the ISR store via the gateway, and there is no page preview route.
 */
export function useOrderPreview(
  config: CouponLayoutConfig,
  documentId: string | undefined,
  active: boolean,
  reloadToken: number,
  pendingTopPicks: readonly CouponCandidate[],
  pendingOrdered: readonly CouponCandidate[],
): OrderPreviewSource {
  // Same client as every other request in this feature. A bare `fetch` would
  // resolve against the admin's own origin, which breaks wherever the admin is
  // served from a different host or base path than the API.
  const { post } = useFetchClient();
  const [state, setState] = React.useState<OrderPreviewSource>({
    sequence: [],
    savedOrderedIds: [],
    total: 0,
    loading: false,
    error: null,
  });

  React.useEffect(() => {
    if (!active) return;

    const resolvedDocumentId = documentId?.trim();
    if (!resolvedDocumentId) {
      setState({
        sequence: [],
        savedOrderedIds: [],
        total: 0,
        loading: false,
        error: 'Save this entry once to preview the resulting order.',
      });
      return;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));

    const run = async () => {
      try {
        const res = await post(
          `/entity-coupon-layout/${config.kind}/${resolvedDocumentId}/preview`,
          {
            data: {
              topPickCouponIds: pendingTopPicks.map(
                (coupon) => coupon.documentId,
              ),
              orderedCouponIds: pendingOrdered.map(
                (coupon) => coupon.documentId,
              ),
              limit: PREVIEW_PAGE_SIZE,
            },
          },
        );
        const body = res?.data?.data ?? res?.data;
        if (cancelled) return;

        setState({
          sequence: (Array.isArray(body?.coupons) ? body.coupons : []).map(
            toCandidate,
          ),
          savedOrderedIds: pendingOrdered.map(
            (coupon) => coupon.documentId,
          ),
          total: Number(body?.pagination?.total) || 0,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[coupon-layout] Failed to load order preview', err);
        setState({
          sequence: [],
          savedOrderedIds: [],
          total: 0,
          loading: false,
          error: 'Could not load the current order from the public API.',
        });
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [
    active,
    config.kind,
    documentId,
    pendingOrdered,
    pendingTopPicks,
    post,
    reloadToken,
  ]);

  return state;
}
