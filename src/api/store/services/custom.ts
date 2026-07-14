import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';

// Raw Knex ON PURPOSE: rating votes must NOT go through strapi.documents —
// the global documents middleware in src/index.ts enqueues static rebuilds on
// every documents-API write, and anonymous votes must never trigger a rebuild.

const POSTGRES_CLIENTS = ['pg', 'postgres', 'postgresql'];
const SQLITE_CLIENTS = ['sqlite', 'sqlite3', 'better-sqlite3'];
const RELATED_STORE_LIMIT = 6;
const MAX_RELATED_STORE_LIMIT = 12;
const CATEGORY_FILTER_LIMIT = 12;
const CATEGORY_SOURCE_OFFER_LIMIT = 120;
const RELATED_OFFER_LIMIT = 320;

const OFFER_SORT = [
  { isPopular: 'desc' },
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

const candidateStoreRef = { fields: ['name', 'slug'] };
const hydratedStoreRef = {
  fields: ['name', 'slug', 'logoAlt'],
  populate: { logo: true },
};
const categoryRef = { fields: ['name', 'slug'] };

function isUniqueViolation(err: any): boolean {
  return (
    err?.code === '23505' || // Postgres
    err?.errno === 1062 || // MySQL ER_DUP_ENTRY
    /UNIQUE constraint failed/i.test(String(err?.message ?? '')) // SQLite
  );
}

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
  if (document?.primaryStore) owners.push(document.primaryStore);

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

function currentStoreCouponFilter(currentStore: any): Record<string, any> {
  return {
    stores: { documentId: currentStore.documentId },
    ...publishedOnlyFilters(),
  };
}

function currentStoreDealFilter(currentStore: any): Record<string, any> {
  return {
    $or: [
      { stores: { documentId: currentStore.documentId } },
      { primaryStore: { documentId: currentStore.documentId } },
    ],
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  /**
   * Return stores that share categories with the current store's visible
   * coupon/deal inventory. The UI passes category ids/slugs it already fetched
   * from /stores/:slug/coupons and /stores/:slug/deals; if absent, this falls
   * back to sampling the current store's offer categories.
   */
  async relatedStores(slug: string, query: Record<string, unknown> = {}) {
    const limit = parsePositiveInteger(
      query.limit,
      RELATED_STORE_LIMIT,
      MAX_RELATED_STORE_LIMIT,
    );

    const stores = await strapi.documents('api::store.store').findMany({
      filters: { slug },
      fields: ['name', 'slug', 'logoAlt'],
      populate: { logo: true },
      limit: 1,
    } as any);

    const currentStore = stores[0] as any;
    if (!currentStore) return null;

    let categoryDocumentIds = parseCsv(query.categoryDocumentIds);
    let categorySlugs = parseCsv(query.categorySlugs);
    const callerAlreadyKnowsCategories =
      oneString(query.categorySource) === 'storeOffers';

    if (
      categoryDocumentIds.length === 0 &&
      categorySlugs.length === 0 &&
      !callerAlreadyKnowsCategories
    ) {
      const [coupons, deals] = (await Promise.all([
        strapi.documents('api::coupon.coupon').findMany({
          filters: currentStoreCouponFilter(currentStore),
          fields: ['title'],
          populate: { categories: categoryRef },
          sort: OFFER_SORT,
          limit: CATEGORY_SOURCE_OFFER_LIMIT,
        } as any),
        strapi.documents('api::deal.deal').findMany({
          filters: currentStoreDealFilter(currentStore),
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
      return { store: publicStore(currentStore), stores: [] };
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
        fields: ['title', 'isPopular'],
        populate: { stores: candidateStoreRef, categories: categoryRef },
        sort: OFFER_SORT,
        limit: RELATED_OFFER_LIMIT,
      } as any),
      strapi.documents('api::deal.deal').findMany({
        filters,
        fields: ['title', 'isPopular'],
        populate: {
          stores: candidateStoreRef,
          primaryStore: candidateStoreRef,
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
        popularHits: number;
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
        if (isSameStore(owner, currentStore)) continue;

        const key = documentKey(owner);
        if (!key || !owner?.slug || !owner?.name) continue;

        const entry =
          ranked.get(key) ??
          {
            store: owner,
            offerCount: 0,
            popularHits: 0,
            categories: new Set<string>(),
          };

        entry.offerCount += 1;
        if (offer?.isPopular) entry.popularHits += 1;
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

        const byPopularity = b.popularHits - a.popularHits;
        if (byPopularity) return byPopularity;

        const byName = String(a.store.name ?? '').localeCompare(
          String(b.store.name ?? ''),
        );
        if (byName) return byName;

        return String(documentKey(a.store) ?? '').localeCompare(
          String(documentKey(b.store) ?? ''),
        );
      })
      .slice(0, limit);

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

      if (!hydratedStore) return [];
      return [
        publicStore(
          hydratedStore,
          entry.offerCount,
          entry.categories.size,
        ),
      ];
    });

    return {
      store: publicStore(currentStore),
      stores: relatedStores,
    };
  },

  /**
   * Record one rating vote and return the fresh aggregate.
   * Returns null when no store matches the slug, and the current aggregate
   * with `alreadyVoted: true` when this client has voted on this store before
   * (enforced by the store_rating_votes UNIQUE constraint, so it survives
   * restarts and multi-node deploys).
   */
  async submitRating(slug: string, value: number, ipHash: string) {
    const knex = strapi.db.connection;
    const client: string = (knex as any)?.client?.config?.client ?? '';

    const store = await knex('stores')
      .where({ slug })
      .select(['id', 'rating_average', 'rating_count'])
      .first();
    if (!store) return null;

    // The vote row is the dedupe gate: only apply the aggregate update when
    // this insert actually lands. A concurrent duplicate loses on the unique
    // constraint and reports alreadyVoted instead of double-counting.
    try {
      await knex('store_rating_votes').insert({
        store_id: store.id,
        ip_hash: ipHash,
        value,
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        return {
          ratingAverage: Number(store.rating_average ?? 0),
          ratingCount: Number(store.rating_count ?? 0),
          alreadyVoted: true,
        };
      }
      throw err;
    }

    // rating_average is assigned BEFORE rating_count: MySQL applies SET left to
    // right, Postgres reads old-row values — this order is correct on both.
    const update = knex('stores')
      .where({ id: store.id })
      .update({
        rating_average: knex.raw(
          'ROUND(((COALESCE(rating_average, 0) * COALESCE(rating_count, 0)) + ?) / (COALESCE(rating_count, 0) + 1.0), 2)',
          [value],
        ),
        rating_count: knex.raw('COALESCE(rating_count, 0) + 1'),
      });

    if (POSTGRES_CLIENTS.includes(client) || SQLITE_CLIENTS.includes(client)) {
      const rows = await update.returning(['rating_average', 'rating_count']);
      const row = rows?.[0];
      if (!row) return null;
      return {
        ratingAverage: Number(row.rating_average),
        ratingCount: Number(row.rating_count),
        alreadyVoted: false,
      };
    }

    // MySQL has no RETURNING: UPDATE yields the affected-row count, so read
    // the fresh values back.
    await update;
    const row = await knex('stores')
      .where({ id: store.id })
      .select(['rating_average', 'rating_count'])
      .first();
    if (!row) return null;
    return {
      ratingAverage: Number(row.rating_average),
      ratingCount: Number(row.rating_count),
      alreadyVoted: false,
    };
  },
});
