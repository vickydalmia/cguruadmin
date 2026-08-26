import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import type { EntityPageType } from './entity-page';
import { buildEntityPopularSearches } from './entity-popular-searches';
import {
  ENTITY_CONFIG,
  FALLBACK_STORE_MIN_POOL,
  MAX_RELATED_STORE_LIMIT,
  OFFER_SORT,
  RELATED_OFFER_LIMIT,
  RELATED_STORE_LIMIT,
  CATEGORY_SOURCE_OFFER_LIMIT,
  candidateStoreFilter,
  candidateStoreRef,
  categoryFilter,
  categoryRef,
  documentKey,
  highRatedStoreFallback,
  hydratedStoreRef,
  isSameStore,
  oneString,
  parseCsv,
  parsePositiveInteger,
  publicStore,
  relatedStoresResponse,
  relationArray,
  sourceCouponFilter,
  sourceDealFilter,
  storeOwners,
  uniqueCategoryFilters,
} from './related-stores';

// Related-Store discovery and ranking live in ./related-stores; this file
// keeps the service surface (entityPopularSearches, relatedStores,
// submitRating).

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
