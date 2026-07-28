import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';

import { toCandidate, type CouponCandidate } from './coupon-layout';
import type { CouponLayoutConfig } from './config';
import {
  isTerminalRefreshState,
  refreshPollDelayMs,
  REFRESH_POLL_MAX_ATTEMPTS,
} from './refresh-poll';

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
    get(
      `/entity-coupon-layout/${config.kind}/${encodeURIComponent(documentId)}`,
    )
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
    if (!outboxId || isTerminalRefreshState(currentState)) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      attempts += 1;
      try {
        const response = await get(
          `/entity-coupon-layout/refresh/${outboxId}`,
        );
        if (cancelled) return;
        const body = response?.data?.data ?? response?.data;
        const next = String(body?.state ?? 'queued');
        // Only re-render when the value actually moved. This used to spread a
        // fresh object every tick, re-rendering the panel every two seconds
        // even when nothing had changed.
        setState((current) =>
          current.data && current.data.refresh?.state !== next
            ? {
                ...current,
                data: {
                  ...current.data,
                  refresh: { outboxId, state: next },
                },
              }
            : current,
        );
        if (isTerminalRefreshState(next)) return;
      } catch {
        // Keep the saved state and retry; refresh status must never turn a
        // successful layout write into a false save failure.
      }
      if (cancelled || attempts >= REFRESH_POLL_MAX_ATTEMPTS) return;
      timer = setTimeout(poll, refreshPollDelayMs(attempts));
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
