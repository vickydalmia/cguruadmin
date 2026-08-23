// Related-Store DISCOVERY & RANKING: candidate pools from shared
// categories and offers, dedupe/ownership rules, hydration refs and the
// high-rated fallback. Split out of the store custom service (see
// ./custom.ts).
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import type { EntityPageType } from './entity-page';

export const RELATED_STORE_LIMIT = 6;

export const MAX_RELATED_STORE_LIMIT = 12;

const CATEGORY_FILTER_LIMIT = 12;

export const CATEGORY_SOURCE_OFFER_LIMIT = 120;

export const RELATED_OFFER_LIMIT = 320;

export const FALLBACK_STORE_MIN_POOL = 24;

export const ENTITY_CONFIG: Record<
  EntityPageType,
  { uid: string; relationField: 'stores' | 'brands' | 'categories' | 'banks' }
> = {
  store: { uid: 'api::store.store', relationField: 'stores' },
  brand: { uid: 'api::brand.brand', relationField: 'brands' },
  category: { uid: 'api::category.category', relationField: 'categories' },
  bank: { uid: 'api::bank.bank', relationField: 'banks' },
};

export const OFFER_SORT = [
  // Editor-controlled sort key — see NEWEST_FIRST in src/utils/offer-visibility.ts.
  { publishedOn: 'desc' },
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

export const candidateStoreRef = { fields: ['name', 'slug'] };

export const hydratedStoreRef = {
  fields: ['name', 'slug', 'logoAlt'],
  populate: { logo: true },
};

export const categoryRef = { fields: ['name', 'slug'] };

export function oneString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parsePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const raw = oneString(value);
  if (!raw || !/^\d+$/u.test(raw)) return fallback;
  return Math.max(1, Math.min(Number(raw), max));
}

export function parseCsv(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of values) {
    const raw = oneString(item);
    if (!raw) continue;

    for (const part of raw.split(',')) {
      const normalized = part.trim();
      if (
        normalized.length === 0 ||
        normalized.length > 160 ||
        seen.has(normalized)
      ) {
        continue;
      }

      seen.add(normalized);
      result.push(normalized);
      if (result.length >= CATEGORY_FILTER_LIMIT) return result;
    }
  }

  return result;
}

export function relationArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function documentKey(document: any): string | null {
  if (document?.documentId) return String(document.documentId);
  if (document?.id) return `id:${document.id}`;
  if (document?.slug) return `slug:${document.slug}`;
  return null;
}

export function isSameStore(candidate: any, current: any): boolean {
  const candidateKey = documentKey(candidate);
  const currentKey = documentKey(current);

  if (candidateKey && currentKey && candidateKey === currentKey) return true;

  return Boolean(candidate?.slug && current?.slug && candidate.slug === current.slug);
}

export function storeOwners(document: any): any[] {
  const owners = relationArray(document?.stores);

  const seen = new Set<string>();
  return owners.filter((store) => {
    const key = documentKey(store);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function categoryFilter(
  documentIds: string[],
  slugs: string[],
): Record<string, any> | null {
  const clauses: Record<string, any>[] = [];

  if (documentIds.length > 0) {
    clauses.push({ categories: { documentId: { $in: documentIds } } });
  }

  if (slugs.length > 0) {
    clauses.push({ categories: { slug: { $in: slugs } } });
  }

  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0]!;
  return { $or: clauses };
}

export function sourceCouponFilter(
  entityType: EntityPageType,
  source: any,
): Record<string, any> {
  return {
    [ENTITY_CONFIG[entityType].relationField]: { documentId: source.documentId },
    ...publishedOnlyFilters(),
  };
}

export function sourceDealFilter(
  entityType: EntityPageType,
  source: any,
): Record<string, any> {
  if (entityType !== 'store') return sourceCouponFilter(entityType, source);

  return {
    stores: { documentId: source.documentId },
    ...publishedOnlyFilters(),
  };
}

export function candidateStoreFilter(stores: any[]): Record<string, any> | null {
  const documentIds: string[] = [];
  const slugs: string[] = [];

  for (const store of stores) {
    const documentId = oneString(store?.documentId)?.trim();
    const slug = oneString(store?.slug)?.trim();
    if (documentId) documentIds.push(documentId);
    if (slug) slugs.push(slug);
  }

  const clauses: Record<string, any>[] = [];
  if (documentIds.length > 0) {
    clauses.push({ documentId: { $in: [...new Set(documentIds)] } });
  }
  if (slugs.length > 0) {
    clauses.push({ slug: { $in: [...new Set(slugs)] } });
  }

  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0]!;
  return { $or: clauses };
}

export function uniqueCategoryFilters(categories: any[]): {
  documentIds: string[];
  slugs: string[];
} {
  const documentIds: string[] = [];
  const slugs: string[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    const documentId = oneString(category?.documentId)?.trim();
    const slug = oneString(category?.slug)?.trim();
    const key = documentId ? `doc:${documentId}` : slug ? `slug:${slug}` : null;

    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (documentId) {
      documentIds.push(documentId);
    } else if (slug) {
      slugs.push(slug);
    }

    if (documentIds.length + slugs.length >= CATEGORY_FILTER_LIMIT) break;
  }

  return { documentIds, slugs };
}

export function publicStore(store: any, offerCount = 0, sharedCategoryCount = 0) {
  return {
    id: store?.id,
    documentId: store?.documentId ?? null,
    name: store?.name ?? null,
    slug: store?.slug ?? null,
    logo: store?.logo ?? null,
    logoAlt: store?.logoAlt ?? null,
    offerCount,
    sharedCategoryCount,
  };
}

export function relatedStoresResponse(
  entityType: EntityPageType,
  source: any,
  stores: any[],
) {
  return entityType === 'store'
    ? { store: publicStore(source), stores }
    : { stores };
}

export async function highRatedStoreFallback(
  strapi: Core.Strapi,
  entityType: EntityPageType,
  source: any,
  limit: number,
) {
  const documents = ((await strapi.documents('api::store.store').findMany({
    ...hydratedStoreRef,
    // Only genuinely rated Stores belong in a "high-rated" fallback. This also
    // avoids PostgreSQL's NULLS-FIRST behaviour on `ratingAverage DESC`, which
    // would otherwise let unrated Stores (null rating from the WP migration)
    // fill the bounded pool and crowd out every rated Store.
    filters: { ratingAverage: { $notNull: true } },
    sort: [
      { ratingAverage: 'desc' },
      { ratingCount: 'desc' },
      { updatedAt: 'desc' },
      { name: 'asc' },
    ],
    limit: Math.max(limit * 3, FALLBACK_STORE_MIN_POOL),
  } as any)) ?? []) as any[];
  const seen = new Set<string>();
  const stores: any[] = [];

  for (const document of documents) {
    if (
      !document?.name ||
      !document?.slug ||
      !document?.logo ||
      (entityType === 'store' && isSameStore(document, source))
    ) {
      continue;
    }
    const key = documentKey(document);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    stores.push(publicStore(document));
    if (stores.length >= limit) break;
  }

  return stores;
}
