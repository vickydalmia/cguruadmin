import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';

import { toCandidate, type CouponCandidate } from './coupon-layout';
import type { CouponLayoutConfig } from './config';

const PAGE_SIZE = 50;

export type PoolSort = 'newest' | 'title';

const SORT_PARAM: Record<PoolSort, string> = {
  // Editors curate by recency, so this is the default. The old panel sorted
  // alphabetically, which is close to random when six Coupons are all called
  // "Flat 10% Off".
  newest: 'publishedOn:DESC',
  title: 'title:ASC',
};

export type CouponPool = {
  candidates: CouponCandidate[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  /**
   * How many live Coupons the entry has in total, ignoring the search box.
   * Null until the first unsearched response lands. Callers use it to reason
   * about the entry itself — `candidates.length` answers a different question
   * once a search is active.
   */
  libraryTotal: number | null;
};

/**
 * Live Coupons related to this entity, in the order editors think in.
 *
 * Scoping matches the public visibility rule exactly: a Coupon can pass its
 * `expiresAt` up to five minutes before the scheduler flips `contentStatus`,
 * so both are filtered or a dead Coupon shows up in the picker during that
 * window.
 */
export function useCouponPool(
  config: CouponLayoutConfig,
  documentId: string | undefined,
  search: string,
  sort: PoolSort,
  active: boolean,
): CouponPool {
  const { get } = useFetchClient();
  const [candidates, setCandidates] = React.useState<CouponCandidate[]>([]);
  const [page, setPage] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [libraryTotal, setLibraryTotal] = React.useState<number | null>(null);

  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  React.useEffect(() => {
    setCandidates([]);
    setPage(1);
    setPageCount(1);
  }, [debouncedSearch, sort, documentId, config.scopeRelationField]);

  React.useEffect(() => {
    if (!active || !documentId) return;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort: SORT_PARAM[sort],
        });
        if (debouncedSearch) {
          params.set('filters[title][$containsi]', debouncedSearch);
        }
        params.set(
          `filters[${config.scopeRelationField}][documentId][$eq]`,
          documentId,
        );
        params.set('filters[contentStatus][$eq]', 'published');
        params.set('filters[$or][0][expiresAt][$null]', 'true');
        params.set('filters[$or][1][expiresAt][$gt]', new Date().toISOString());

        const res = await get(
          `/content-manager/collection-types/api::coupon.coupon?${params.toString()}`,
        );
        if (cancelled) return;

        const body = res?.data?.data ?? res?.data;
        const results: any[] = body?.results ?? [];
        const mapped = results.map(toCandidate);
        setCandidates((prev) => (page === 1 ? mapped : [...prev, ...mapped]));
        setPageCount(body?.pagination?.pageCount ?? 1);
        if (!debouncedSearch) {
          const total = Number(body?.pagination?.total);
          setLibraryTotal(Number.isFinite(total) ? total : mapped.length);
        }
      } catch (err) {
        console.error('[coupon-layout] Failed to load Coupon candidates', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [
    active,
    page,
    debouncedSearch,
    sort,
    documentId,
    config.scopeRelationField,
    get,
  ]);

  const hasMore = page < pageCount;
  const loadMore = React.useCallback(() => {
    setPage((current) => current + 1);
  }, []);

  return { candidates, loading, hasMore, loadMore, libraryTotal };
}
