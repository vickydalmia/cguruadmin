import { factories } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';

function mergePublishedFilter(existingFilters: any = {}) {
  return {
    $and: [existingFilters, publishedOnlyFilters()],
  };
}

function isPublishedResponse(response: any) {
  return response?.data?.contentStatus === 'published';
}

export default factories.createCoreController('api::deal.deal', () => ({
  async find(ctx) {
    ctx.query = {
      ...ctx.query,
      filters: mergePublishedFilter(ctx.query?.filters),
    };

    return await super.find(ctx);
  },

  async findOne(ctx) {
    const response = await super.findOne(ctx);
    if (!response?.data) {
      return response;
    }
    if (!isPublishedResponse(response)) {
      return ctx.notFound('Deal not found');
    }

    return response;
  },
}));
