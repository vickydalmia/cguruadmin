import type { Core } from '@strapi/strapi';

const MAX_PAGE_SIZE = 100;
const clampPageSize = (raw: unknown, fallback: number) =>
  Math.max(1, Math.min(Number(raw) || fallback, MAX_PAGE_SIZE));

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async getCouponsByEntity(ctx) {
    const { slug } = ctx.params;
    const { entityType } = ctx.state;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = clampPageSize(ctx.query.pageSize, 20);

    const apiId = `api::${entityType}.${entityType}` as any;

    const entities = await strapi.documents(apiId).findMany({
      filters: { slug },
      populate: ['logo', 'faqs', 'icon'],
      status: 'published',
      limit: 1,
    });

    const entity = entities[0];
    if (!entity) {
      return ctx.notFound(`${entityType} not found`);
    }

    const filters: Record<string, any> = {
      [entityType]: { documentId: entity.documentId },
      $or: [
        { expiresAt: { $null: true } },
        { expiresAt: { $gt: new Date() } },
      ],
    };

    const coupons = await strapi.documents('api::coupon.coupon').findMany({
      filters,
      status: 'published',
      populate: ['image', 'tags', 'store', 'bank', 'category', 'brand'],
      sort: [{ isPopular: 'desc' }, { createdAt: 'desc' }],
      start: (page - 1) * pageSize,
      limit: pageSize,
    });

    const total = await strapi.documents('api::coupon.coupon').count({ filters, status: 'published' });

    return ctx.send({
      [entityType]: entity,
      coupons,
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

    const entities = await strapi.documents(apiId).findMany({
      filters: { slug },
      populate: ['logo', 'icon'],
      status: 'published',
      limit: 1,
    });

    const entity = entities[0];
    if (!entity) {
      return ctx.notFound(`${entityType} not found`);
    }

    const filters: Record<string, any> = {
      [entityType]: { documentId: entity.documentId },
      $or: [
        { expiresAt: { $null: true } },
        { expiresAt: { $gt: new Date() } },
      ],
    };

    const deals = await strapi.documents('api::deal.deal').findMany({
      filters,
      status: 'published',
      populate: ['dealImage', 'tags', 'displayStore', 'store', 'bank', 'category', 'brand'],
      sort: [{ isPopular: 'desc' }, { createdAt: 'desc' }],
      start: (page - 1) * pageSize,
      limit: pageSize,
    });

    const total = await strapi.documents('api::deal.deal').count({ filters, status: 'published' });

    return ctx.send({
      [entityType]: entity,
      deals,
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

    const tags = await strapi.documents('api::tag.tag').findMany({
      filters: { slug: tagSlug },
      limit: 1,
    });

    const tag = tags[0];
    if (!tag) {
      return ctx.notFound('Tag not found');
    }

    const filters = {
      tags: { documentId: tag.documentId },
      $or: [
        { expiresAt: { $null: true } },
        { expiresAt: { $gt: new Date() } },
      ],
    };

    const deals = await strapi.documents('api::deal.deal').findMany({
      filters,
      status: 'published',
      populate: ['dealImage', 'displayStore', 'store', 'tags'],
      sort: { createdAt: 'desc' },
      start: (page - 1) * pageSize,
      limit: pageSize,
    });

    const total = await strapi.documents('api::deal.deal').count({ filters, status: 'published' });

    return ctx.send({
      tag,
      deals,
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

    const [stores, banks, categories, brands] = await Promise.all([
      strapi.documents('api::store.store').findMany({
        filters: searchFilters, fields, limit: 5, status: 'published',
      }),
      strapi.documents('api::bank.bank').findMany({
        filters: searchFilters, fields, limit: 5, status: 'published',
      }),
      strapi.documents('api::category.category').findMany({
        filters: searchFilters, fields, limit: 5, status: 'published',
      }),
      strapi.documents('api::brand.brand').findMany({
        filters: searchFilters, fields, limit: 5, status: 'published',
      }),
    ]);

    return ctx.send({
      stores: stores.map((s) => ({ name: s.name, link: `/${s.slug}`, type: 'store' })),
      banks: banks.map((b) => ({ name: b.name, link: `/${b.slug}`, type: 'bank' })),
      categories: categories.map((c) => ({ name: c.name, link: `/${c.slug}`, type: 'category' })),
      brands: brands.map((b) => ({ name: b.name, link: `/${b.slug}`, type: 'brand' })),
    });
  },
});
