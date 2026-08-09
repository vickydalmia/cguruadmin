import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';

import type { RelationCandidate } from '../../utils/single-relation';
import { PAGE_SIZE } from './config';
import type { RelationConfig } from './types';

export function useRelationCandidates({
  config,
  deferred,
  documentId,
}: {
  config: RelationConfig;
  deferred: boolean;
  documentId?: string;
}) {
  const { get } = useFetchClient();
  const [candidates, setCandidates] = React.useState<RelationCandidate[]>([]);
  const [page, setPage] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [initialLoaded, setInitialLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  // Bumping the counter re-fires the fetch effect with otherwise-identical
  // inputs — the retry channel, same pattern as the persisted-selection load.
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');

  React.useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timeout);
  }, [search]);

  React.useEffect(() => {
    setCandidates([]);
    setPage(1);
    setPageCount(1);
    setInitialLoaded(false);
  }, [debouncedSearch, config.target, config.scopeRelationField, documentId]);

  React.useEffect(() => {
    if (!deferred || (config.scopeRelationField && !documentId)) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      // Cleared at request START so a retry drops the error banner
      // immediately instead of flashing it under the spinner.
      setLoadError(false);
      try {
        const mainField = config.mainField ?? 'name';
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort: `${mainField}:ASC`,
        });
        if (debouncedSearch) {
          params.set(`filters[${mainField}][$containsi]`, debouncedSearch);
        }
        if (config.scopeRelationField && documentId) {
          params.set(
            `filters[${config.scopeRelationField}][documentId][$eq]`,
            documentId,
          );
          // contentStatus alone is not enough: an offer can sit past its
          // exact expiresAt for up to five minutes before the status cron
          // flips contentStatus, and this picker must not offer it in that
          // window — hence the extra expiresAt null-or-future filter.
          params.set('filters[contentStatus][$eq]', 'published');
          params.set('filters[$or][0][expiresAt][$null]', 'true');
          params.set(
            'filters[$or][1][expiresAt][$gt]',
            new Date().toISOString(),
          );
        }
        const response = await get(
          `/content-manager/collection-types/${config.target}?${params.toString()}`,
        );
        const body = response?.data?.data ?? response?.data;
        const results: any[] = body?.results ?? [];
        if (cancelled) return;
        const list: RelationCandidate[] = results.map((row: any) => ({
          id: row.id,
          documentId: row.documentId,
          name: row.name ?? row.title ?? String(row.id),
          ...(typeof row.isAffiliate === 'boolean'
            ? { isAffiliate: row.isAffiliate }
            : {}),
        }));
        setCandidates((previous) =>
          page === 1 ? list : [...previous, ...list],
        );
        setPageCount(body?.pagination?.pageCount ?? 1);
        setInitialLoaded(true);
      } catch (error) {
        console.error(`[taxonomy-panel] Failed to load ${config.field}`, error);
        // Surface it — an errored picker rendering as an empty list with no
        // explanation and no retry reads as "there is nothing to pick".
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [
    deferred,
    page,
    debouncedSearch,
    config.target,
    config.field,
    config.mainField,
    config.scopeRelationField,
    documentId,
    get,
    loadAttempt,
  ]);

  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const hasMore = page < pageCount;
  React.useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPage((currentPage) => currentPage + 1);
        }
      },
      { root: element.parentElement, rootMargin: '50px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, candidates.length]);

  const retryCandidates = React.useCallback(
    () => setLoadAttempt((attempt) => attempt + 1),
    [],
  );

  return {
    candidates,
    loading,
    initialLoaded,
    loadError,
    retryCandidates,
    search,
    setSearch,
    debouncedSearch,
    sentinelRef,
  };
}
