import * as React from 'react';

import { type RelationCandidate as Candidate } from '../../../utils/single-relation';
import { PAGE_SIZE, type RelationConfig } from '../config';

// Candidate search + pagination for one relation section: the debounced
// name search, page accumulation, and the sentinel-driven infinite scroll.
// Extracted verbatim from relation-section.tsx.
export function useCandidateSearch({
  config,
  deferred,
  documentId,
  stableExtraFilters,
  get,
}: {
  config: RelationConfig;
  deferred: boolean;
  documentId?: string;
  stableExtraFilters: Record<string, string> | null;
  get: (url: string) => Promise<any>;
}) {
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [page, setPage] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [initialLoaded, setInitialLoaded] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setCandidates([]);
    setPage(1);
    setPageCount(1);
    setInitialLoaded(false);
  }, [
    debouncedSearch,
    config.target,
    documentId,
    stableExtraFilters,
  ]);

  React.useEffect(() => {
    if (!deferred) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        // Every taxonomy target labels its rows with `name` — sort and search
        // by it directly.
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort: 'name:ASC',
        });
        if (debouncedSearch) {
          params.set('filters[name][$containsi]', debouncedSearch);
        }
        if (stableExtraFilters) {
          for (const [key, value] of Object.entries(stableExtraFilters)) {
            params.set(key, value);
          }
        }
        const res = await get(
          `/content-manager/collection-types/${config.target}?${params.toString()}`
        );
        const body = res?.data?.data ?? res?.data;
        const results: any[] = body?.results ?? [];
        if (cancelled) return;
        const list: Candidate[] = results.map((r: any) => ({
          id: r.id,
          documentId: r.documentId,
          name: r.name ?? r.title ?? String(r.id),
        }));
        setCandidates((prev) => (page === 1 ? list : [...prev, ...list]));
        setPageCount(body?.pagination?.pageCount ?? 1);
        setInitialLoaded(true);
      } catch (err) {
        console.error(`[taxonomy-panel] Failed to load ${config.field}`, err);
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
    documentId,
    stableExtraFilters,
    get,
  ]);

  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const hasMore = page < pageCount;

  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPage((p) => p + 1);
        }
      },
      { root: el.parentElement, rootMargin: '50px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, candidates.length]);

  return {
    candidates,
    loading,
    initialLoaded,
    search,
    setSearch,
    debouncedSearch,
    sentinelRef,
  };
}
