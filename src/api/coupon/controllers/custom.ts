import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';

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

// Ordering shared by every offer/deal listing: popular first, then most
// recently published, then most recently touched. Mirrors the by-entity sort.
const DEFAULT_OFFER_SORT = [
  { isPopular: 'desc' },
  { publishedAt: 'desc' },
  { updatedAt: 'desc' },
];

// Public-safe scalar whitelists. Richtext `content` is included since the
// `excerpt` field was removed — the frontend derives card summaries from it.
// The homepage whitelists (src/api/homepage/controllers/custom.ts) still
// exclude content because nothing on the homepage consumes it.
const COUPON_PUBLIC_FIELDS = [
  'title',
  'content',
  'code',
  'couponType',
  'affiliateLink',
  'expiresAt',
  'isPopular',
  'offerType',
  'contentStatus',
];
const DEAL_PUBLIC_FIELDS = [
  'title',
  'content',
  'code',
  'salePrice',
  'mrp',
  'discount',
  'affiliateLink',
  'expiresAt',
  'isPopular',
  'offerType',
  'contentStatus',
];

// Related-entity refs expose only name/slug (+ logo/icon media, +logoAlt for
// alt text). Nothing else about a store/bank/brand/category leaks into a listing.
const storeRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const bankRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const brandRef = { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } };
const categoryRef = { fields: ['name', 'slug'], populate: { icon: true } };
const tagRef = { fields: ['name', 'slug'] };

// Coupon populate for public listings. `uniqueCouponPool` is populated with the
// pool NAME only — its `codes` relation is never referenced, so redeemable
// unique codes can never be harvested through this endpoint.
const COUPON_PUBLIC_POPULATE = {
  image: true,
  cashbackItems: true,
  tags: tagRef,
  stores: storeRef,
  banks: bankRef,
  categories: categoryRef,
  brands: brandRef,
  uniqueCouponPool: { fields: ['name'] },
};

const DEAL_PUBLIC_POPULATE = {
  dealImage: true,
  cashbackItems: true,
  tags: tagRef,
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
  const data = await sanitizeDocumentOutput(strapi, ctx, uid, items);

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

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async getCouponsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const apiId = `api::${entityType}.${entityType}` as any;
    const entityQuery = await sanitizeDocumentQuery(strapi, ctx, apiId, {
      filters: { slug },
      populate: entityPopulate(entityType),
      limit: 1,
    });

    const entities = await strapi.documents(apiId).findMany(entityQuery);

    const entity = entities[0];
    if (!entity) {
      return ctx.notFound(`${entityType} not found`);
    }

    const relationField = PLURAL_FIELD[entityType] || entityType;
    const filters: Record<string, any> = {
      [relationField]: { documentId: entity.documentId },
      ...visibilityFilters(),
    };
    const couponsQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::coupon.coupon', {
      filters,
      populate: {
        image: true,
        tags: true,
        stores: true,
        banks: true,
        categories: true,
        brands: true,
        cashbackItems: true,
        uniqueCouponPool: { fields: ['name'] },
      },
      sort: [{ isPopular: 'desc' }, { publishedAt: 'desc' }, { updatedAt: 'desc' }],
      start: (page - 1) * pageSize,
      limit: pageSize,
    });
    const countQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::coupon.coupon', {
      filters,
    });

    const coupons = await strapi.documents('api::coupon.coupon').findMany(couponsQuery);
    const total = await strapi.documents('api::coupon.coupon').count(countQuery);
    const sanitizedEntity = await sanitizeDocumentOutput(strapi, ctx, apiId, entity);
    const sanitizedCoupons = await sanitizeDocumentOutput(strapi, ctx, 'api::coupon.coupon', coupons);

    return ctx.send({
      [entityType]: sanitizedEntity,
      coupons: sanitizedCoupons,
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    });
  },

  async getDealsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const apiId = `api::${entityType}.${entityType}` as any;
    const entityQuery = await sanitizeDocumentQuery(strapi, ctx, apiId, {
      filters: { slug },
      populate: entityPopulate(entityType),
      limit: 1,
    });

    const entities = await strapi.documents(apiId).findMany(entityQuery);

    const entity = entities[0];
    if (!entity) {
      return ctx.notFound(`${entityType} not found`);
    }

    const relationField = PLURAL_FIELD[entityType] || entityType;
    const filters: Record<string, any> = {
      [relationField]: { documentId: entity.documentId },
      ...visibilityFilters(),
    };
    const dealsQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::deal.deal', {
      filters,
      populate: {
        dealImage: true,
        tags: true,
        stores: true,
        banks: true,
        categories: categoryRef,
        brands: true,
        cashbackItems: true,
        primaryStore: true,
      },
      sort: [{ isPopular: 'desc' }, { publishedAt: 'desc' }, { updatedAt: 'desc' }],
      start: (page - 1) * pageSize,
      limit: pageSize,
    });
    const countQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::deal.deal', {
      filters,
    });

    const deals = await strapi.documents('api::deal.deal').findMany(dealsQuery);
    const total = await strapi.documents('api::deal.deal').count(countQuery);
    const sanitizedEntity = await sanitizeDocumentOutput(strapi, ctx, apiId, entity);
    const sanitizedDeals = await sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', deals);

    return ctx.send({
      [entityType]: sanitizedEntity,
      deals: sanitizedDeals,
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    });
  },

  async getDealsByTag(ctx) {
    const { tagSlug } = ctx.params;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 28);
    const tagQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::tag.tag', {
      filters: { slug: tagSlug },
      limit: 1,
    });

    const tags = await strapi.documents('api::tag.tag').findMany(tagQuery);

    const tag = tags[0];
    if (!tag) {
      return ctx.notFound('Tag not found');
    }

    const filters = {
      tags: { documentId: tag.documentId },
      ...visibilityFilters(),
    };
    const dealsQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::deal.deal', {
      filters,
      populate: ['dealImage', 'stores', 'tags'],
      sort: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
      start: (page - 1) * pageSize,
      limit: pageSize,
    });
    const countQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::deal.deal', {
      filters,
    });

    const deals = await strapi.documents('api::deal.deal').findMany(dealsQuery);
    const total = await strapi.documents('api::deal.deal').count(countQuery);
    const sanitizedTag = await sanitizeDocumentOutput(strapi, ctx, 'api::tag.tag', tag);
    const sanitizedDeals = await sanitizeDocumentOutput(strapi, ctx, 'api::deal.deal', deals);

    return ctx.send({
      tag: sanitizedTag,
      deals: sanitizedDeals,
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
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
