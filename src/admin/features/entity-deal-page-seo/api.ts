import type { IdentityKind } from '../../../utils/route-normalization';
import type {
  EntityDealPageListResponse,
  EntityDealPageRow,
  EntityDealPageSeoInput,
  IndexState,
} from './types';

// These endpoints live on the ADMIN router, so they carry no /api prefix — see
// src/index.ts. useFetchClient attaches the admin session token.
const BASE = '/entity-deal-page/pages';

// Must match SETTINGS_SORT_FIELDS in the entity-deal-page service.
export const SORT_FIELDS = ['name', 'liveDealCount', 'updatedAt'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type Sort = { field: SortField; desc: boolean };

export const DEFAULT_SORT: Sort = { field: 'name', desc: false };

/**
 * Clicking the active column flips direction; clicking a new one starts it in
 * the direction that answers the obvious question — "which pages have the most
 * Deals?" and "what changed most recently?" both want descending first, while
 * a name column wants A-Z.
 */
export function nextSort(current: Sort, field: SortField): Sort {
  if (current.field === field) return { field, desc: !current.desc };
  return { field, desc: field !== 'name' };
}

export type ListQuery = {
  page: number;
  pageSize: number;
  kind: IdentityKind | '';
  indexState: IndexState | '';
  search: string;
  sort: Sort;
};

export function listQueryString(query: ListQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: `${query.sort.field}:${query.sort.desc ? 'desc' : 'asc'}`,
  });
  if (query.kind) params.set('kind', query.kind);
  if (query.indexState) params.set('indexState', query.indexState);
  if (query.search.trim()) params.set('search', query.search.trim());
  return `${BASE}?${params.toString()}`;
}

export function updatePath(kind: IdentityKind, documentId: string): string {
  return `${BASE}/${kind}/${encodeURIComponent(documentId)}`;
}

/**
 * Normalize the editor form into the PATCH payload.
 *
 * Empty strings become null rather than "": the backend treats null as "no
 * override, use the generated fallback", while an empty string would be a
 * pointless stored value that still round-trips through validation.
 */
export function toSeoPatch(
  form: Record<string, string | boolean>,
): EntityDealPageSeoInput {
  const text = (value: unknown): string | null => {
    const raw = typeof value === 'string' ? value.trim() : '';
    return raw === '' ? null : raw;
  };

  return {
    indexingEnabled: form.indexingEnabled === true,
    metaTitle: text(form.metaTitle),
    metaDescription: text(form.metaDescription),
    canonicalUrl: text(form.canonicalUrl),
    ogTitle: text(form.ogTitle),
    ogDescription: text(form.ogDescription),
    ogImageAlt: text(form.ogImageAlt),
  };
}

/** Seed the form from authored values only — never from resolvedSeo. */
export function toFormState(row: EntityDealPageRow) {
  const seo = row.entityDealPageSeo ?? {};
  return {
    indexingEnabled: seo.indexingEnabled === true,
    metaTitle: seo.metaTitle ?? '',
    metaDescription: seo.metaDescription ?? '',
    canonicalUrl: seo.canonicalUrl ?? '',
    ogTitle: seo.ogTitle ?? '',
    ogDescription: seo.ogDescription ?? '',
    ogImageAlt: seo.ogImageAlt ?? '',
  };
}

export type SeoFormState = ReturnType<typeof toFormState>;

export function unwrapList(payload: unknown): EntityDealPageListResponse {
  const body = payload as any;
  const data = Array.isArray(body?.data) ? body.data : [];
  const pagination = body?.meta?.pagination ?? {};
  return {
    data,
    meta: {
      pagination: {
        page: Number(pagination.page) || 1,
        pageSize: Number(pagination.pageSize) || 25,
        total: Number(pagination.total) || 0,
        pageCount: Math.max(Number(pagination.pageCount) || 1, 1),
      },
    },
  };
}
