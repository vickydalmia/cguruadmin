// Offer ENTITY LISTINGS: the per-entity coupon/deal listing pipeline —
// filters, ordered-coupon merge, top-pick hydration and pagination. One of
// the modules split out of the coupon controller (see
// ../controllers/custom.ts).
import type { Core } from '@strapi/strapi';
import { resolveEntityLastUpdate } from './entity-last-update';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import {
  COUPON_PUBLIC_FIELDS,
  COUPON_PUBLIC_POPULATE,
  DEAL_PUBLIC_POPULATE,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_OFFER_SORT,
  clampPageSize,
  visibilityFilters,
} from './offer-projections';
import {
  sanitizeDocumentOutput,
  sanitizeDocumentQuery,
  sanitizePublicDocumentOutput,
  sanitizePublicDocumentQuery,
} from './offer-sanitizers';

// Editors may promote any ten live, entity-scoped Coupons into an explicit
// first-page order. This is deliberately separate from the mapped `coupons`
// membership relation: a category can own 1300+ Coupons without turning all of
// them into a curated sequence or creating a huge `$notIn` query.
const ORDERED_COUPON_LIMIT = 10;

// Map singular entityType to plural relation field name on coupons/deals
const PLURAL_FIELD: Record<string, string> = {
  store: 'stores',
  bank: 'banks',
  category: 'categories',
  brand: 'brands',
};

// Shared driver for the global /offers and /deals listings: published-only
// filter, whitelisted fields + populate, sanitized output, and a { data,
// pagination } envelope. `sort` may be overridden via ?sort= (validated by the
// content API); otherwise falls back to DEFAULT_OFFER_SORT.
export async function listPublishedOffers(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  fields: string[],
  populate: Record<string, any>,
) {
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = clampPageSize(ctx.query.pageSize, DEFAULT_LIST_PAGE_SIZE);
  const sort = ctx.query.sort ?? DEFAULT_OFFER_SORT;
  const filters = visibilityFilters();

  const listQuery = await sanitizeDocumentQuery(strapi, ctx, uid, {
    filters,
    fields,
    populate,
    sort,
    start: (page - 1) * pageSize,
    limit: pageSize,
  });
  const countQuery = await sanitizeDocumentQuery(strapi, ctx, uid, { filters });

  const documents = strapi.documents(uid as any);
  const items = await documents.findMany(listQuery);
  const total = await documents.count(countQuery);
  const data = arrayizeOfferText(await sanitizeDocumentOutput(strapi, ctx, uid, items));
  await attachFestiveOffers(strapi, data);

  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      pageCount: Math.ceil(total / pageSize),
    },
  };
}

// Categories carry `icon`; stores/banks/brands carry `logo`. Object-style
// populate is validated strictly, so only reference fields that exist.
export const entityPopulate = (entityType: string) => ({
  [entityType === 'category' ? 'icon' : 'logo']: true,
  faqs: true,
  seo: { populate: { ogImage: true } },
});

export function entityOfferFilters(
  entityType: string,
  documentId: string,
  entity: 'coupon' | 'deal',
) {
  const relationField = PLURAL_FIELD[entityType] || entityType;
  return {
    [relationField]: { documentId },
    ...visibilityFilters(),
  };
}

export async function hydrateEntityTopPickCoupons(
  strapi: Core.Strapi,
  orderedIds: readonly string[],
  entityType: string,
  entitySlug: string,
): Promise<any[]> {
  if (orderedIds.length === 0) return [];

  const query = await sanitizePublicDocumentQuery(
    strapi,
    'api::coupon.coupon',
    {
      fields: COUPON_PUBLIC_FIELDS,
      filters: {
        documentId: { $in: orderedIds },
        [PLURAL_FIELD[entityType] || entityType]: { slug: entitySlug },
        ...visibilityFilters(),
      },
      populate: COUPON_PUBLIC_POPULATE,
      limit: orderedIds.length,
    },
  );
  const fetched = await strapi
    .documents('api::coupon.coupon')
    .findMany(query);
  const byId = new Map(
    fetched.map((coupon: any) => [coupon.documentId, coupon]),
  );
  const ordered = orderedIds
    .map((documentId) => byId.get(documentId))
    .filter(Boolean);

  const topPicks = arrayizeOfferText(
    await sanitizePublicDocumentOutput(
      strapi,
      'api::coupon.coupon',
      ordered,
    ),
  );
  await attachFestiveOffers(strapi, topPicks);
  return topPicks;
}

// Return an entity's Coupons with its explicit `orderedCoupons` selection
// first, then every other member newest-first. Product Deals have no curated
// entity-side relation and therefore always use the newest-first path.
//
// `entityOfferFilters` remains the true membership source, so a selection can
// never limit the entity to ten Coupons. Empty selection means every offer is
// newest-first. Returns null when the slug misses.
//
// NOTE: relies on Strapi ordering the populated relation by the link table's
// order column (getJoinTableOrderBy in @strapi/database populate/apply).
// Strapi's Document Service rejects `limit` inside a relation populate, so the
// ID-only relation is capped in JavaScript after it is fetched.
export async function listEntityOffers(
  strapi: Core.Strapi,
  ctx: any,
  opts: {
    apiId: string;
    entityType: string;
    slug: string;
    relationField: 'coupons' | 'deals';
    offerUid: string;
    offerFields: string[];
    offerPopulate: Record<string, any>;
    offerKind: 'coupon' | 'deal';
    page: number;
    pageSize: number;
  },
): Promise<{ sanitizedEntity: any; offers: any[]; total: number } | null> {
  const { apiId, entityType, slug, relationField, offerUid, offerFields, offerPopulate, offerKind, page, pageSize } = opts;
  const start = (page - 1) * pageSize;

  const entityQuery = await sanitizeDocumentQuery(strapi, ctx, apiId, {
    filters: { slug },
    populate: {
      ...entityPopulate(entityType),
      ...(offerKind === 'coupon'
        ? {
            orderedCoupons: {
              fields: ['documentId'],
              filters: {
                ...visibilityFilters(),
                [PLURAL_FIELD[entityType] || entityType]: { slug },
              },
            },
          }
        : {}),
    },
    limit: 1,
  });
  // Coupon-only relations are part of the Coupon endpoint's reviewed output
  // contract. Re-apply their safe ID-only populates after auth-aware query
  // sanitization so an optional server API token cannot silently remove them.
  // Product Deal Top Deals are derived from Deal records and never use these
  // Coupon relations.
  const sanitizedPopulate =
    entityQuery.populate &&
    typeof entityQuery.populate === 'object' &&
    !Array.isArray(entityQuery.populate)
      ? (entityQuery.populate as Record<string, any>)
      : {};
  entityQuery.populate = {
    ...sanitizedPopulate,
    ...(offerKind === 'coupon'
      ? {
          topPickCoupons: {
            fields: ['documentId'],
            filters: {
              ...visibilityFilters(),
              [PLURAL_FIELD[entityType] || entityType]: { slug },
            },
          },
          orderedCoupons: {
            fields: ['documentId'],
            filters: {
              ...visibilityFilters(),
              [PLURAL_FIELD[entityType] || entityType]: { slug },
            },
          },
        }
      : {}),
  };
  const entity = (await strapi.documents(apiId as any).findMany(entityQuery))[0];
  if (!entity) return null;

  const topPickIds: string[] = (
    offerKind === 'coupon' && Array.isArray(entity.topPickCoupons)
      ? entity.topPickCoupons
      : []
  )
    .map((coupon: any) => coupon?.documentId)
    .filter(Boolean)
    .slice(0, 4);
  const orderedIds: string[] = (
    offerKind === 'coupon' && Array.isArray(entity.orderedCoupons)
      ? entity.orderedCoupons
      : []
  )
    .map((offer: any) => offer?.documentId)
    .filter(Boolean)
    .slice(0, ORDERED_COUPON_LIMIT);
  // Strip ID-only relations before sanitizing for output. Top Picks are
  // attached from their separately sanitized public Coupon projection.
  delete entity[relationField];
  delete entity.topPickCoupons;
  delete entity.orderedCoupons;
  const sanitizedEntity = await sanitizeDocumentOutput(strapi, ctx, apiId, entity);
  if (offerKind === 'coupon') {
    const lastUpdate = await resolveEntityLastUpdate(strapi, {
      entityType,
      entityId: Number(entity.id),
      entityUpdatedAt: entity.updatedAt,
    });
    sanitizedEntity.lastUpdatedAt = lastUpdate.updatedAt;
    sanitizedEntity.lastUpdatedByName = lastUpdate.updatedByName;
  }
  if (offerKind === 'coupon') {
    sanitizedEntity.topPickCoupons = await hydrateEntityTopPickCoupons(
      strapi,
      topPickIds,
      entityType,
      slug,
    );
    // The storefront needs this identity-only projection to keep automatic Top
    // Pick fallbacks separate from the explicitly ordered main-list Coupons.
    sanitizedEntity.orderedCouponIds = orderedIds;
  }

  // Taxonomy is the true membership source. The remainder is every related
  // offer not selected in Ordered Coupons, appended newest-first.
  const memberFilters = entityOfferFilters(entityType, entity.documentId, offerKind);
  // Hydrate the complete (maximum ten) editorial head before deriving totals
  // or offsets. A Coupon can expire or lose membership after the relation
  // populate above; counting its stale id as a slot creates a short page and
  // shifts every later remainder offset by one.
  let hydratedOrderedOffers: any[] = [];
  if (orderedIds.length) {
    const orderedQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, {
      fields: offerFields,
      filters: {
        ...memberFilters,
        documentId: { $in: orderedIds },
      },
      populate: offerPopulate,
      limit: ORDERED_COUPON_LIMIT,
    });
    const fetched = await strapi.documents(offerUid as any).findMany(orderedQuery);
    const byId = new Map(fetched.map((offer: any) => [offer.documentId, offer]));
    hydratedOrderedOffers = orderedIds
      .map((id) => byId.get(id))
      .filter(Boolean);
  }
  const hydratedOrderedIds = hydratedOrderedOffers.map(
    (offer) => offer.documentId,
  );
  const restFilters = hydratedOrderedIds.length
    ? { ...memberFilters, documentId: { $notIn: hydratedOrderedIds } }
    : memberFilters;

  const restCountQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, { filters: restFilters });
  const restCount = await strapi.documents(offerUid as any).count(restCountQuery);
  const total = hydratedOrderedIds.length + restCount;

  // Page = the drag-ordered slice first; newest-first members fill the rest.
  const orderedOffers = hydratedOrderedOffers.slice(start, start + pageSize);
  const remaining = pageSize - orderedOffers.length;

  let restOffers: any[] = [];
  if (remaining > 0 && restCount > 0) {
    // Once the ordered head is consumed, page into the newest-first remainder.
    const restStart = Math.max(0, start - hydratedOrderedIds.length);
    const restQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, {
      fields: offerFields,
      filters: restFilters,
      populate: offerPopulate,
      sort: DEFAULT_OFFER_SORT,
      start: restStart,
      limit: remaining,
    });
    restOffers = await strapi.documents(offerUid as any).findMany(restQuery);
  }

  return { sanitizedEntity, offers: [...orderedOffers, ...restOffers], total };
}
