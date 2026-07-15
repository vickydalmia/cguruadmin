import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { arrayizeOfferText } from '../../../utils/offer-text';

const MAX_PAGE_SIZE = 100;
const clampPageSize = (raw: unknown, fallback: number) =>
  Math.max(1, Math.min(Number(raw) || fallback, MAX_PAGE_SIZE));

// Map singular entityType to plural relation field name on coupons/deals
const PLURAL_FIELD: Record<string, string> = {
  store: 'stores',
  bank: 'banks',
  category: 'categories',
  brand: 'brands',
};

const visibilityFilters = () => publishedOnlyFilters();

// Default page size for the global /offers and /deals listings (max 100 via
// clampPageSize). Matches the "24 per page" grid the frontend renders.
const DEFAULT_LIST_PAGE_SIZE = 24;

// Ordering for the global offer/deal listings: newest first. Per-entity
// listings (store/category/brand/bank) instead follow the admin-curated
// relation order — see getCouponsByEntity/getDealsByEntity.
const DEFAULT_OFFER_SORT = [
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

// Public-safe scalar whitelists. Richtext `content` is included since the
// `excerpt` field was removed — the frontend derives card summaries from it.
// The homepage whitelists (src/api/homepage/controllers/custom.ts) still
// exclude content because nothing on the homepage consumes it.
const COUPON_PUBLIC_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'content',
  'code',
  'couponType',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
];
const DEAL_PUBLIC_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'content',
  'code',
  'salePrice',
  'mrp',
  'discount',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
];

// Related-entity refs expose only name/slug (+ logo/icon media, +logoAlt for
// alt text). Nothing else about a store/bank/brand/category leaks into a listing.
const storeRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const bankRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const brandRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const categoryRef = { fields: ['name', 'slug'], populate: { icon: true } };
// Coupon populate for public listings. `uniqueCouponPool` is populated with the
// pool NAME only — its `codes` relation is never referenced, so redeemable
// unique codes can never be harvested through this endpoint.
const COUPON_PUBLIC_POPULATE = {
  image: true,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
  uniqueCouponPool: { fields: ['name'] },
};

const DEAL_PUBLIC_POPULATE = {
  dealImage: true,
  primaryStore: storeRef,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
};

// Shared driver for the global /offers and /deals listings: published-only
// filter, whitelisted fields + populate, sanitized output, and a { data,
// pagination } envelope. `sort` may be overridden via ?sort= (validated by the
// content API); otherwise falls back to DEFAULT_OFFER_SORT.
async function listPublishedOffers(
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
const entityPopulate = (entityType: string) => ({
  [entityType === 'category' ? 'icon' : 'logo']: true,
  faqs: true,
  seo: { populate: { ogImage: true } },
});

function entityOfferFilters(
  entityType: string,
  documentId: string,
  entity: 'coupon' | 'deal',
) {
  if (entityType === 'store' && entity === 'deal') {
    return {
      $or: [
        { stores: { documentId } },
        { primaryStore: { documentId } },
      ],
      ...visibilityFilters(),
    };
  }
  const relationField = PLURAL_FIELD[entityType] || entityType;
  return {
    [relationField]: { documentId },
    ...visibilityFilters(),
  };
}

function contentType(strapi: Core.Strapi, uid: string) {
  return strapi.contentType(uid as any) as any;
}

async function sanitizeDocumentQuery(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  query: Record<string, any>,
) {
  const schema = contentType(strapi, uid);
  await strapi.contentAPI.validate.query(query, schema, { auth: ctx.state.auth });
  return await strapi.contentAPI.sanitize.query(query, schema, { auth: ctx.state.auth });
}

async function sanitizeDocumentOutput(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  data: any,
) {
  const schema = contentType(strapi, uid);
  return (await strapi.contentAPI.sanitize.output(data, schema, {
    auth: ctx.state.auth,
  })) as any;
}

// Return an entity's offers with the admin-curated relation (drag) order first,
// then every other offer that belongs to the entity — newest-first — filling
// the rest. Editors reorder the coupons/deals relation on the entity's edit
// page; Strapi persists that order, and populating the relation returns offers
// in it.
//
// The "rest" matters because the drag-ordered relation is not always the full
// membership: a Store's `deals` manyToMany omits deals linked only via
// `primaryStore`. `entityOfferFilters` (the $or over stores/primaryStore for
// Store deals) is the true membership, so members not in the ordered relation
// are appended and counted — never silently dropped or under-paginated.
//
// This also subsumes the "empty relation" case: with no drag order, every offer
// comes from the newest-first member query. Returns null when the slug misses.
//
// NOTE: relies on Strapi returning the populated relation in its stored order
// and without a low default cap — verify against the live instance (see plan).
async function listEntityOffers(
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
      [relationField]: { fields: ['documentId'], filters: visibilityFilters() },
    },
    limit: 1,
  });
  const entity = (await strapi.documents(apiId as any).findMany(entityQuery))[0];
  if (!entity) return null;

  const orderedIds: string[] = (Array.isArray(entity[relationField]) ? entity[relationField] : [])
    .map((offer: any) => offer?.documentId)
    .filter(Boolean);
  // Strip the (potentially large) id-only relation before sanitizing for output.
  delete entity[relationField];
  const sanitizedEntity = await sanitizeDocumentOutput(strapi, ctx, apiId, entity);

  // True membership (superset of the ordered relation for Store deals). The
  // "rest" is everything that belongs to the entity but is NOT in the drag
  // order — appended newest-first after the curated head.
  const memberFilters = entityOfferFilters(entityType, entity.documentId, offerKind);
  const restFilters = orderedIds.length
    ? { ...memberFilters, documentId: { $notIn: orderedIds } }
    : memberFilters;

  const restCountQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, { filters: restFilters });
  const restCount = await strapi.documents(offerUid as any).count(restCountQuery);
  const total = orderedIds.length + restCount;

  // Page = the drag-ordered slice first; newest-first members fill the rest.
  const pageOrderedIds = orderedIds.slice(start, start + pageSize);
  const remaining = pageSize - pageOrderedIds.length;

  let orderedOffers: any[] = [];
  if (pageOrderedIds.length) {
    const orderedQuery = await sanitizeDocumentQuery(strapi, ctx, offerUid, {
      fields: offerFields,
      filters: { documentId: { $in: pageOrderedIds } },
      populate: offerPopulate,
    });
    const fetched = await strapi.documents(offerUid as any).findMany(orderedQuery);
    const byId = new Map(fetched.map((offer: any) => [offer.documentId, offer]));
    orderedOffers = pageOrderedIds.map((id) => byId.get(id)).filter(Boolean);
  }

  let restOffers: any[] = [];
  if (remaining > 0 && restCount > 0) {
    // Once the ordered head is consumed, page into the newest-first remainder.
    const restStart = Math.max(0, start - orderedIds.length);
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async getCouponsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const result = await listEntityOffers(strapi, ctx, {
      apiId: `api::${entityType}.${entityType}`,
      entityType,
      slug,
      relationField: 'coupons',
      offerUid: 'api::coupon.coupon',
      offerFields: COUPON_PUBLIC_FIELDS,
      offerPopulate: COUPON_PUBLIC_POPULATE,
      offerKind: 'coupon',
      page,
      pageSize,
    });
    if (!result) return ctx.notFound(`${entityType} not found`);

    const coupons = arrayizeOfferText(
      await sanitizeDocumentOutput(strapi, ctx, 'api::coupon.coupon', result.offers)
    );

    return ctx.send({
      [entityType]: result.sanitizedEntity,
      coupons,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pageCount: Math.ceil(result.total / pageSize),
      },
    });
  },

  async getDealsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const result = await listEntityOffers(strapi, ctx, {
      apiId: `api::${entityType}.${entityType}`,
      entityType,
      slug,
      relationField: 'deals',
      offerUid: 'api::deal.deal',
      offerFields: DEAL_PUBLIC_FIELDS,
      offerPopulate: DEAL_PUBLIC_POPULATE,
      offerKind: 'deal',
      page,
      pageSize,
    });
    if (!result) return ctx.notFound(`${entityType} not found`);

    const deals = arrayizeOfferText(
      await sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', result.offers)
    );

    return ctx.send({
      [entityType]: result.sanitizedEntity,
      deals,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pageCount: Math.ceil(result.total / pageSize),
      },
    });
  },

  // GET /api/offers — paginated list of ALL published coupons across the site.
  async getAllOffers(ctx) {
    const result = await listPublishedOffers(
      strapi,
      ctx,
      'api::coupon.coupon',
      COUPON_PUBLIC_FIELDS,
      COUPON_PUBLIC_POPULATE,
    );
    return ctx.send(result);
  },

  // GET /api/deals — paginated list of ALL published deals across the site.
  async getAllDeals(ctx) {
    const result = await listPublishedOffers(
      strapi,
      ctx,
      'api::deal.deal',
      DEAL_PUBLIC_FIELDS,
      DEAL_PUBLIC_POPULATE,
    );
    return ctx.send(result);
  },

});
