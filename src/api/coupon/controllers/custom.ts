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
        categories: true,
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

  async search(ctx) {
    const { query } = ctx.query;

    if (!query || (query as string).length < 2) {
      return ctx.send({ stores: [], banks: [], categories: [], brands: [] });
    }

    const searchFilters = { name: { $containsi: query } };
    const fields = ['name', 'slug'] as any;
    const storeQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::store.store', {
      filters: searchFilters,
      fields,
      limit: 5,
    });
    const bankQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::bank.bank', {
      filters: searchFilters,
      fields,
      limit: 5,
    });
    const categoryQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::category.category', {
      filters: searchFilters,
      fields,
      limit: 5,
    });
    const brandQuery = await sanitizeDocumentQuery(strapi, ctx, 'api::brand.brand', {
      filters: searchFilters,
      fields,
      limit: 5,
    });

    const [stores, banks, categories, brands] = await Promise.all([
      strapi.documents('api::store.store').findMany(storeQuery),
      strapi.documents('api::bank.bank').findMany(bankQuery),
      strapi.documents('api::category.category').findMany(categoryQuery),
      strapi.documents('api::brand.brand').findMany(brandQuery),
    ]);
    const [sanitizedStores, sanitizedBanks, sanitizedCategories, sanitizedBrands] = await Promise.all([
      sanitizeDocumentOutput(strapi, ctx, 'api::store.store', stores),
      sanitizeDocumentOutput(strapi, ctx, 'api::bank.bank', banks),
      sanitizeDocumentOutput(strapi, ctx, 'api::category.category', categories),
      sanitizeDocumentOutput(strapi, ctx, 'api::brand.brand', brands),
    ]);
    const safeStores = sanitizedStores as Array<{ name: string; slug: string }>;
    const safeBanks = sanitizedBanks as Array<{ name: string; slug: string }>;
    const safeCategories = sanitizedCategories as Array<{ name: string; slug: string }>;
    const safeBrands = sanitizedBrands as Array<{ name: string; slug: string }>;

    return ctx.send({
      stores: safeStores.map((s) => ({ name: s.name, link: `/${s.slug}`, type: 'store' })),
      banks: safeBanks.map((b) => ({ name: b.name, link: `/${b.slug}`, type: 'bank' })),
      categories: safeCategories.map((c) => ({ name: c.name, link: `/${c.slug}`, type: 'category' })),
      brands: safeBrands.map((b) => ({ name: b.name, link: `/${b.slug}`, type: 'brand' })),
    });
  },
});
