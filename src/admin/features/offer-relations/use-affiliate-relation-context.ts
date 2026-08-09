import { useFetchClient, useForm } from '@strapi/strapi/admin';
import * as React from 'react';

import {
  CHECKOUT_MERCHANT_FIELD,
  parseCheckoutMerchant,
} from '../../../constants/checkout-merchant';
import {
  clearAffiliateState,
  dedupeBrandRefs,
  publishAffiliateState,
} from '../../utils/affiliate-state';
import { storeAddBlocked } from '../../utils/affiliate-exclusion';
import type { AffiliateContext, RelationConfig, SelectionReport } from './types';

const FLAG_LOOKUP_MAX_ATTEMPTS = 3;

export function useAffiliateRelationContext({
  configs,
  model,
  documentId,
}: {
  configs: RelationConfig[];
  model: string;
  documentId?: string;
}) {
  const { get } = useFetchClient();
  const hasAffiliateRule = configs.some((config) => config.affiliateRule);
  // Reports are keyed by the edited ENTRY, and reads ignore any other key —
  // on in-place same-model navigation the publish effect below would
  // otherwise fire once with the previous entry's verdict under the new
  // documentId before the reset commit lands.
  const entryKey = `${model}:${documentId ?? 'new'}`;
  const [reports, setReports] = React.useState<{
    key: string;
    map: Record<string, SelectionReport>;
  }>({ key: entryKey, map: {} });
  // Affiliate flags of SELECTED brands. A brand ticked in-session carries the
  // flag on its candidate row; persisted selections do not (the relations
  // endpoint returns no custom fields) — resolve those with one filtered
  // lookup, cached per documentId for this ENTRY (reset below when the
  // edited document changes).
  const flagCacheRef = React.useRef(new Map<string, boolean>());
  const [flagsVersion, setFlagsVersion] = React.useState(0);
  // Bounded auto-retry for a failed lookup, then a visible manual Retry —
  // without either, a single network hiccup left the panel blocked
  // (fail-safe, but unrecoverable) until a reload. The attempt counter IS
  // the request counter: MAX means that many requests in total.
  const [flagsAttempt, setFlagsAttempt] = React.useState(0);
  const [flagsError, setFlagsError] = React.useState(false);

  const reportSelection = React.useCallback(
    (field: string, report: SelectionReport) => {
      setReports((previous) => {
        const base = previous.key === entryKey ? previous.map : {};
        const existing = base[field];
        const unchanged =
          previous.key === entryKey &&
          existing &&
          existing.ready === report.ready &&
          existing.entries.length === report.entries.length &&
          existing.entries.every((entry, index) => {
            const next = report.entries[index];
            return (
              entry.documentId === next.documentId &&
              entry.name === next.name &&
              entry.isAffiliate === next.isAffiliate
            );
          });
        return unchanged
          ? previous
          : { key: entryKey, map: { ...base, [field]: report } };
      });
    },
    [entryKey],
  );

  React.useEffect(() => {
    flagCacheRef.current = new Map();
    setFlagsAttempt(0);
    setFlagsError(false);
  }, [model, documentId]);

  const currentReports = reports.key === entryKey ? reports.map : {};
  const storesReport = currentReports.stores;
  const brandsReport = currentReports.brands;
  const unknownFlagDocIds = React.useMemo(() => {
    const cache = flagCacheRef.current;
    return (brandsReport?.entries ?? [])
      .filter(
        (entry) =>
          entry.isAffiliate === undefined && !cache.has(entry.documentId),
      )
      .map((entry) => entry.documentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandsReport, flagsVersion]);

  const unknownFlagKey = unknownFlagDocIds.join('|');
  React.useEffect(() => {
    setFlagsAttempt(0);
    setFlagsError(false);
  }, [unknownFlagKey]);

  React.useEffect(() => {
    if (!hasAffiliateRule || unknownFlagDocIds.length === 0) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      // Clear the error as each request STARTS, so the exhausted-budget
      // banner cannot flash (with a Retry that would cancel this attempt)
      // while the final automatic request is still in flight — it appears
      // only once that request has actually failed.
      setFlagsError(false);
      try {
        const params = new URLSearchParams({
          page: '1',
          pageSize: '100',
          'fields[0]': 'documentId',
          'filters[isAffiliate][$eq]': 'true',
        });
        // Cache verdicts ONLY for the ids this request actually queried —
        // caching the whole unknown set would poison everything past the
        // page cap as "not affiliate". The flagsVersion bump re-derives the
        // unknown set, so the effect re-fires and chunks through the rest.
        const queried = unknownFlagDocIds.slice(0, 100);
        queried.forEach((docId, index) => {
          params.set(`filters[documentId][$in][${index}]`, docId);
        });
        const response = await get(
          `/content-manager/collection-types/api::brand.brand?${params.toString()}`,
        );
        if (cancelled) return;
        const body = response?.data?.data ?? response?.data;
        const results: any[] = body?.results ?? [];
        const affiliateIds = new Set(
          results
            .map((row: any) => row?.documentId)
            .filter(
              (value: unknown): value is string => typeof value === 'string',
            ),
        );
        const cache = flagCacheRef.current;
        for (const docId of queried) {
          cache.set(docId, affiliateIds.has(docId));
        }
        setFlagsError(false);
        setFlagsVersion((version) => version + 1);
      } catch (error) {
        // Unresolved flags keep the affected adds blocked (fail-safe), so an
        // error degrades to a stricter panel, never an invalid save.
        console.error(
          '[taxonomy-panel] Failed to resolve affiliate brand flags',
          error,
        );
        if (cancelled) return;
        setFlagsError(true);
        if (flagsAttempt + 1 < FLAG_LOOKUP_MAX_ATTEMPTS) {
          retryTimer = setTimeout(
            () => setFlagsAttempt((attempt) => attempt + 1),
            1500 * (flagsAttempt + 1),
          );
        }
      }
    };
    run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [get, hasAffiliateRule, unknownFlagDocIds, flagsAttempt]);

  const merchantValue = useForm(
    'PanelBody',
    (state) => state.values?.[CHECKOUT_MERCHANT_FIELD],
  );
  const affiliateContext = React.useMemo((): AffiliateContext | null => {
    if (!hasAffiliateRule) return null;
    const cache = flagCacheRef.current;
    const brandEntries = brandsReport?.entries ?? [];
    // Deduplicate as {documentId, name} PAIRS and derive the id set and name
    // list from that one list — deduplicating the ids independently of the
    // names would mislabel every ref after a duplicate.
    const affiliateSelectedRefs = dedupeBrandRefs(
      brandEntries
        .filter(
          (entry) =>
            (entry.isAffiliate ?? cache.get(entry.documentId)) === true,
        )
        .map((entry) => ({ documentId: entry.documentId, name: entry.name })),
    );
    return {
      storeCount: storesReport?.entries.length ?? 0,
      storesReady: storesReport?.ready ?? false,
      brandsReady: brandsReport?.ready ?? false,
      affiliateFlagsReady: brandEntries.every(
        (entry) =>
          entry.isAffiliate !== undefined || cache.has(entry.documentId),
      ),
      affiliateSelectedRefs,
      affiliateSelectedDocIds: new Set(
        affiliateSelectedRefs.map((ref) => ref.documentId),
      ),
      affiliateSelectedNames: affiliateSelectedRefs.map((ref) => ref.name),
      merchant: parseCheckoutMerchant(merchantValue),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAffiliateRule, storesReport, brandsReport, flagsVersion, merchantValue]);

  const merchantBlocked = affiliateContext
    ? storeAddBlocked({
        brandsReady: affiliateContext.brandsReady,
        affiliateFlagsReady: affiliateContext.affiliateFlagsReady,
        affiliateSelectedCount: affiliateContext.affiliateSelectedDocIds.size,
      })
    : false;
  const affiliateNames = affiliateContext?.affiliateSelectedNames ?? [];
  const affiliateRefs = affiliateContext?.affiliateSelectedRefs ?? [];
  const affiliateNamesKey = affiliateRefs
    .map((ref) => `${ref.documentId}:${ref.name}`)
    .join('\u0000');
  React.useEffect(() => {
    if (!hasAffiliateRule) return;
    publishAffiliateState(model, documentId, {
      blocked: merchantBlocked,
      brandNames: affiliateNames,
      // The merchant input uses these to RESTRICT its options to the
      // affiliate brand(s) instead of hard-disabling: clearing the field and
      // pointing it at the affiliate brand itself are both server-legal.
      brandRefs: affiliateRefs,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAffiliateRule, model, documentId, merchantBlocked, affiliateNamesKey]);
  React.useEffect(() => {
    if (!hasAffiliateRule) return;
    return () => clearAffiliateState(model, documentId);
  }, [hasAffiliateRule, model, documentId]);

  return {
    affiliateContext,
    reportSelection,
    flagsRetryVisible:
      flagsError &&
      unknownFlagDocIds.length > 0 &&
      flagsAttempt + 1 >= FLAG_LOOKUP_MAX_ATTEMPTS,
    retryFlags: () => {
      setFlagsError(false);
      setFlagsAttempt(0);
    },
  };
}
