import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';

import { toCandidate, type CouponCandidate } from './coupon-layout';
import type { CouponLayoutConfig } from './config';

export type CouponLayoutCapabilities = {
  canRead: boolean;
  canUpdate: boolean;
  canManageLayout: boolean;
  reason: string | null;
};

export type EntityCouponLayout = {
  slug?: string;
  version: string;
  topPickCoupons: CouponCandidate[];
  orderedCoupons: CouponCandidate[];
  counts: { topPicks: number; ordered: number };
  capabilities: CouponLayoutCapabilities;
  refresh?: { outboxId: string; state: string };
};

export function useEntityCouponLayout(
  config: CouponLayoutConfig,
  documentId: string | undefined,
  active: boolean,
) {
  const { get } = useFetchClient();
  const [reloadToken, setReloadToken] = React.useState(0);
  const [state, setState] = React.useState<{
    data: EntityCouponLayout | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: Boolean(documentId), error: null });

  React.useEffect(() => {
    if (!active || !documentId) return;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    get(`/entity-coupon-layout/${config.kind}/${documentId}`)
      .then((response) => {
        if (cancelled) return;
        const body = response?.data?.data ?? response?.data;
        setState({
          data: {
            ...body,
            topPickCoupons: (body?.topPickCoupons ?? []).map(toCandidate),
            orderedCoupons: (body?.orderedCoupons ?? []).map(toCandidate),
          },
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[coupon-layout] Failed to load layout', error);
        setState((current) => ({
          ...current,
          loading: false,
          error: 'Coupon layout could not be loaded. Nothing has been changed.',
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [active, config.kind, documentId, get, reloadToken]);

  React.useEffect(() => {
    const outboxId = state.data?.refresh?.outboxId;
    const currentState = state.data?.refresh?.state;
    if (
      !outboxId ||
      currentState === 'rendered' ||
      currentState === 'failed'
    ) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await get(
          `/entity-coupon-layout/refresh/${outboxId}`,
        );
        if (cancelled) return;
        const body = response?.data?.data ?? response?.data;
        setState((current) =>
          current.data
            ? {
                ...current,
                data: {
                  ...current.data,
                  refresh: {
                    outboxId,
                    state: String(body?.state ?? 'queued'),
                  },
                },
              }
            : current,
        );
      } catch {
        // Keep the saved state and retry; refresh status must never turn a
        // successful layout write into a false save failure.
      }
    };
    void poll();
    const timer = setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [get, state.data?.refresh?.outboxId, state.data?.refresh?.state]);

  return {
    ...state,
    retry: React.useCallback(
      () => setReloadToken((token) => token + 1),
      [],
    ),
    replace: React.useCallback((data: EntityCouponLayout) => {
      setState({ data, loading: false, error: null });
    }, []),
  };
}
