// List query state for the Deal-page SEO screen. All list state lives in
// the URL: a filtered view is shareable, survives a refresh, and the browser
// Back button undoes a filter the way it does on every other Strapi list
// screen.
import * as React from 'react';
import { useQueryParams } from '@strapi/strapi/admin';

import type { IdentityKind } from '../../../utils/route-normalization';
import {
  DEFAULT_SORT_PARAM,
  listQueryString,
  parseSearch,
  parseSort,
  unwrapList,
} from './api';
import type { EntityDealPageRow, IndexState } from './types';
import { DEFAULT_PAGE_SIZE, type ListQueryParams } from './seo-list-config';

export function useSeoList(get: (url: string) => Promise<any>) {
  const [{ query }, setQuery] = useQueryParams<ListQueryParams>({
    page: '1',
    pageSize: String(DEFAULT_PAGE_SIZE),
    sort: DEFAULT_SORT_PARAM,
  });

  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || DEFAULT_PAGE_SIZE;
  const sort = parseSort(query.sort);
  const search = parseSearch(query._q);
  const kind = (query.kind ?? '') as IdentityKind | '';
  const indexState = (query.indexState ?? '') as IndexState | '';

  const [rows, setRows] = React.useState<EntityDealPageRow[]>([]);
  const [pageCount, setPageCount] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);

  const [editing, setEditing] = React.useState<EntityDealPageRow | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  // Any filter change invalidates the current page number: page 3 of an A-Z
  // list has nothing to do with page 3 of a most-Deals-first list.
  const setFilter = (next: Partial<ListQueryParams>) =>
    setQuery({ ...next, page: '1' });

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setForbidden(false);
      try {
        const response = await get(
          listQueryString({ page, pageSize, kind, indexState, search, sort }),
        );
        if (cancelled) return;
        const list = unwrapList(response?.data);
        setRows(list.data);
        setPageCount(list.meta.pagination.pageCount);
        setTotal(list.meta.pagination.total);
      } catch (err: any) {
        if (cancelled) return;
        // 403 here means the account is not a Super Admin. Say that, rather
        // than showing an empty table that looks like "no entities exist".
        const status = err?.response?.status;
        if (status === 403 || status === 401) {
          setForbidden(true);
        } else {
          setError(err?.message ?? 'Failed to load Deal page settings.');
        }
        setRows([]);
        setTotal(0);
        setPageCount(1);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // `sort` and the primitives it is derived from change together; depending on
    // the parsed object would re-fetch on every render.
  }, [
    get,
    page,
    pageSize,
    kind,
    indexState,
    search,
    query.sort,
    reloadToken,
  ]);

  return {
    query,
    setQuery,
    setFilter,
    page,
    pageSize,
    sort,
    search,
    kind,
    indexState,
    rows,
    pageCount,
    total,
    loading,
    error,
    forbidden,
    reload: () => setReloadToken((token) => token + 1),
  };
}
