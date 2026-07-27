import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import type { EntityPageType } from './entity-page';
import { buildEntityPopularSearches } from './entity-popular-searches';

// Raw Knex ON PURPOSE: rating votes must NOT go through strapi.documents —
// the global documents middleware in src/index.ts enqueues static rebuilds on
// every documents-API write, and anonymous votes must never trigger a rebuild.

const RELATED_STORE_LIMIT = 6;
const MAX_RELATED_STORE_LIMIT = 12;
const CATEGORY_FILTER_LIMIT = 12;
const CATEGORY_SOURCE_OFFER_LIMIT = 120;
const RELATED_OFFER_LIMIT = 320;
const FALLBACK_STORE_MIN_POOL = 24;

const ENTITY_CONFIG: Record<
  EntityPageType,
  { uid: string; relationField: 'stores' | 'brands' | 'categories' | 'banks' }
> = {
  store: { uid: 'api::store.store', relationField: 'stores' },
  brand: { uid: 'api::brand.brand', relationField: 'brands' },
  category: { uid: 'api::category.category', relationField: 'categories' },
  bank: { uid: 'api::bank.bank', relationField: 'banks' },
};

const OFFER_SORT = [
  // Editor-controlled sort key — see NEWEST_FIRST in src/utils/offer-visibility.ts.
  { publishedOn: 'desc' },
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

const candidateStoreRef = { fields: ['name', 'slug'] };
const hydratedStoreRef = {
  fields: ['name', 'slug', 'logoAlt'],
  populate: { logo: true },
};
const categoryRef = { fields: ['name', 'slug'] };

function oneString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const raw = oneString(value);
  if (!raw || !/^\d+$/u.test(raw)) return fallback;
  return Math.max(1, Math.min(Number(raw), max));
}

function parseCsv(value: unknown): string[] {
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

function relationArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function documentKey(document: any): string | null {
  if (document?.documentId) return String(document.documentId);
  if (document?.id) return `id:${document.id}`;
  if (document?.slug) return `slug:${document.slug}`;
  return null;
}

function isSameStore(candidate: any, current: any): boolean {
  const candidateKey = documentKey(candidate);
  const currentKey = documentKey(current);

  if (candidateKey && currentKey && candidateKey === currentKey) return true;

  return Boolean(candidate?.slug && current?.slug && candidate.slug === current.slug);
}

function storeOwners(document: any): any[] {
  const owners = relationArray(document?.stores);

  const seen = new Set<string>();
  return owners.filter((store) => {
    const key = documentKey(store);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function categoryFilter(
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

function sourceCouponFilter(
  entityType: EntityPageType,
  source: any,
): Record<string, any> {
  return {
    [ENTITY_CONFIG[entityType].relationField]: { documentId: source.documentId },
    ...publishedOnlyFilters(),
  };
}

function sourceDealFilter(
  entityType: EntityPageType,
  source: any,
): Record<string, any> {
  if (entityType !== 'store') return sourceCouponFilter(entityType, source);

  return {
    stores: { documentId: source.documentId },
    ...publishedOnlyFilters(),
  };
}

function candidateStoreFilter(stores: any[]): Record<string, any> | null {
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

function uniqueCategoryFilters(categories: any[]): {
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

function publicStore(store: any, offerCount = 0, sharedCategoryCount = 0) {
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

function relatedStoresResponse(
  entityType: EntityPageType,
  source: any,
  stores: any[],
) {
  return entityType === 'store'
    ? { store: publicStore(source), stores }
    : { stores };
}

async function highRatedStoreFallback(
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async entityPopularSearches(entityType: EntityPageType, slug: string) {
    const groups = await buildEntityPopularSearches(strapi, entityType, slug);
    return groups ? { groups } : null;
  },

  /** Return Store-only suggestions for any public entity page. */
  async relatedStores(
    entityType: EntityPageType,
    slug: string,
    query: Record<string, unknown> = {},
  ) {
    const limit = parsePositiveInteger(
      query.limit,
      RELATED_STORE_LIMIT,
      MAX_RELATED_STORE_LIMIT,
    );
    const config = ENTITY_CONFIG[entityType];
    const sourceQuery: Record<string, any> = {
      filters: { slug },
      fields: entityType === 'store' ? ['name', 'slug', 'logoAlt'] : ['name', 'slug'],
      limit: 1,
    };
    if (entityType === 'store') sourceQuery.populate = { logo: true };
    const sources = (await strapi
      .documents(config.uid as any)
      .findMany(sourceQuery as any)) as any[];

    const source = sources[0] as any;
    if (!source) return null;

    let categoryDocumentIds = parseCsv(query.categoryDocumentIds);
    let categorySlugs = parseCsv(query.categorySlugs);
    const callerAlreadyKnowsCategories =
      ['storeOffers', 'entityOffers'].includes(oneString(query.categorySource) ?? '');

    if (entityType === 'category') {
      const selectedCategory = uniqueCategoryFilters([source]);
      categoryDocumentIds = selectedCategory.documentIds;
      categorySlugs = selectedCategory.slugs;
    } else if (
      categoryDocumentIds.length === 0 &&
      categorySlugs.length === 0 &&
      !callerAlreadyKnowsCategories
    ) {
      const [coupons, deals] = (await Promise.all([
        strapi.documents('api::coupon.coupon').findMany({
          filters: sourceCouponFilter(entityType, source),
          fields: ['title'],
          populate: { categories: categoryRef },
          sort: OFFER_SORT,
          limit: CATEGORY_SOURCE_OFFER_LIMIT,
        } as any),
        strapi.documents('api::deal.deal').findMany({
          filters: sourceDealFilter(entityType, source),
          fields: ['title'],
          populate: { categories: categoryRef },
          sort: OFFER_SORT,
          limit: CATEGORY_SOURCE_OFFER_LIMIT,
        } as any),
      ])) as [any[], any[]];
      const derived = uniqueCategoryFilters(
        [...coupons, ...deals].flatMap((offer) => relationArray(offer?.categories)),
      );
      categoryDocumentIds = derived.documentIds;
      categorySlugs = derived.slugs;
    }

    const byCategory = categoryFilter(categoryDocumentIds, categorySlugs);
    if (!byCategory) {
      const fallback = await highRatedStoreFallback(
        strapi,
        entityType,
        source,
        limit,
      );
      return relatedStoresResponse(entityType, source, fallback);
    }

    const filters = {
      ...byCategory,
      ...publishedOnlyFilters(),
    };
    const categoryKeys = new Set([
      ...categoryDocumentIds.map((id) => `doc:${id}`),
      ...categorySlugs.map((itemSlug) => `slug:${itemSlug}`),
    ]);
    const [coupons, deals] = (await Promise.all([
      strapi.documents('api::coupon.coupon').findMany({
        filters,
        fields: ['title'],
        populate: { stores: candidateStoreRef, categories: categoryRef },
        sort: OFFER_SORT,
        limit: RELATED_OFFER_LIMIT,
      } as any),
      strapi.documents('api::deal.deal').findMany({
        filters,
        fields: ['title'],
        populate: {
          stores: candidateStoreRef,
          categories: categoryRef,
        },
        sort: OFFER_SORT,
        limit: RELATED_OFFER_LIMIT,
      } as any),
    ])) as [any[], any[]];

    const ranked = new Map<
      string,
      {
        store: any;
        offerCount: number;
        categories: Set<string>;
      }
    >();

    for (const offer of [...coupons, ...deals]) {
      const overlappingCategories = relationArray(offer?.categories)
        .map((category) => {
          const documentId = oneString(category?.documentId);
          const itemSlug = oneString(category?.slug);
          if (documentId && categoryKeys.has(`doc:${documentId}`)) {
            return `doc:${documentId}`;
          }
          if (itemSlug && categoryKeys.has(`slug:${itemSlug}`)) {
            return `slug:${itemSlug}`;
          }
          return null;
        })
        .filter((key): key is string => Boolean(key));

      for (const owner of storeOwners(offer)) {
        if (entityType === 'store' && isSameStore(owner, source)) continue;

        const key = documentKey(owner);
        if (!key || !owner?.slug || !owner?.name) continue;

        const entry =
          ranked.get(key) ??
          {
            store: owner,
            offerCount: 0,
            categories: new Set<string>(),
          };

        entry.offerCount += 1;
        for (const overlappingCategory of overlappingCategories) {
          entry.categories.add(overlappingCategory);
        }
        ranked.set(key, entry);
      }
    }

    const selectedEntries = [...ranked.values()]
      .sort((a, b) => {
        const byCategoryCount = b.categories.size - a.categories.size;
        if (byCategoryCount) return byCategoryCount;

        const byOfferCount = b.offerCount - a.offerCount;
        if (byOfferCount) return byOfferCount;

        const byName = String(a.store.name ?? '').localeCompare(
          String(b.store.name ?? ''),
        );
        if (byName) return byName;

        return String(documentKey(a.store) ?? '').localeCompare(
          String(documentKey(b.store) ?? ''),
        );
      })
      .slice(0, Math.max(limit * 3, FALLBACK_STORE_MIN_POOL));

    const selectedFilter = candidateStoreFilter(
      selectedEntries.map((entry) => entry.store),
    );
    let hydratedStores: any[] = [];
    if (selectedFilter) {
      hydratedStores = (await strapi.documents('api::store.store').findMany({
        filters: selectedFilter,
        ...hydratedStoreRef,
        limit: selectedEntries.length,
      } as any)) as any[];
    }

    const hydratedByDocumentId = new Map<string, any>();
    const hydratedBySlug = new Map<string, any>();
    for (const store of hydratedStores) {
      const documentId = oneString(store?.documentId);
      const itemSlug = oneString(store?.slug);
      if (documentId) hydratedByDocumentId.set(documentId, store);
      if (itemSlug) hydratedBySlug.set(itemSlug, store);
    }

    const relatedStores = selectedEntries.flatMap((entry) => {
      const documentId = oneString(entry.store?.documentId);
      const itemSlug = oneString(entry.store?.slug);
      const hydratedStore =
        (documentId ? hydratedByDocumentId.get(documentId) : undefined) ??
        (itemSlug ? hydratedBySlug.get(itemSlug) : undefined);

      if (!hydratedStore?.logo) return [];
      return [
        publicStore(
          hydratedStore,
          entry.offerCount,
          entry.categories.size,
        ),
      ];
    }).slice(0, limit);
    const stores = relatedStores.length > 0
      ? relatedStores
      : await highRatedStoreFallback(strapi, entityType, source, limit);

    return relatedStoresResponse(entityType, source, stores);
  },

  /** @deprecated Use api::store.entity-page for all entity rating writes. */
  async submitRating(slug: string, value: number, ipHash: string) {
    return await strapi
      .service('api::store.entity-page' as any)
      .submitRating('store', slug, value, ipHash);
  },
});
