import type { Core } from '@strapi/strapi';

const uniqueCouponController = ({ strapi }: { strapi: Core.Strapi }) => ({

  async redeem(ctx) {
    const { poolDocumentId } = ctx.request.body;

    if (!poolDocumentId) {
      return ctx.badRequest('poolDocumentId is required');
    }

    const result = await strapi
      .plugin('unique-coupon')
      .service('unique-coupon')
      .redeemCode(poolDocumentId);

    if (result.success) {
      return ctx.send({ success: true, code: result.code });
    }

    if (result.error === 'NO_CODES_AVAILABLE') {
      return ctx.send({ success: false, error: result.error, message: result.message }, 200);
    }

    return ctx.send({ success: false, error: result.error, message: result.message }, 503);
  },

  async uploadCodes(ctx) {
    const { poolDocumentId, codes } = ctx.request.body;

    if (!poolDocumentId || !codes || !Array.isArray(codes)) {
      return ctx.badRequest('poolDocumentId and codes array required');
    }

    if (codes.length === 0) {
      return ctx.badRequest('Codes array cannot be empty');
    }

    if (codes.length > 100000) {
      return ctx.badRequest('Maximum 100,000 codes per upload');
    }

    const result = await strapi
      .plugin('unique-coupon')
      .service('unique-coupon')
      .importCodes(poolDocumentId, codes);

    return ctx.send({ success: true, imported: result.imported, total: result.total });
  },

  async getStats(ctx) {
    const { poolDocumentId } = ctx.params;

    const stats = await strapi
      .plugin('unique-coupon')
      .service('unique-coupon')
      .getPoolStats(poolDocumentId);

    if (!stats) {
      return ctx.notFound('Pool not found');
    }

    return ctx.send(stats);
  },
});

export default uniqueCouponController;
