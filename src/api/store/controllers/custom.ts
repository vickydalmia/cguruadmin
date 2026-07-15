import type { Core } from '@strapi/strapi';
import crypto from 'crypto';
import { isEntityPageType } from '../services/entity-page';

export default ({ strapi }: { strapi: Core.Strapi }) => ({

  async relatedStores(ctx) {
    const { slug } = ctx.params;
    const entityType = ctx.state.entityType ?? 'store';
    if (!isEntityPageType(entityType)) {
      return ctx.badRequest('Unsupported entity type');
    }
    const result = await strapi
      .service('api::store.custom' as any)
      .relatedStores(entityType, slug, ctx.query);

    if (!result) {
      return ctx.notFound(`${entityType} not found`);
    }

    return ctx.send(result);
  },

  async submitRating(ctx) {
    const { slug } = ctx.params;
    const { value } = ctx.request.body ?? {};
    const entityType = ctx.state.entityType ?? 'store';

    if (!isEntityPageType(entityType)) {
      return ctx.badRequest('Unsupported entity type');
    }

    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return ctx.badRequest('Rating value must be an integer between 1 and 5');
    }

    // One vote per client per entity, enforced by entity_rating_votes. The IP
    // (koa-resolved, honors TRUST_PROXY / X-Forwarded-For like
    // global::rate-limit) is stored only as a salted hash.
    const ip: string = ctx.request.ip || 'unknown';
    const appKeys = strapi.config.get('server.app.keys', ['']) as string[];
    const ipHash = crypto
      .createHash('sha256')
      .update(`${appKeys[0] ?? ''}|${ip}`)
      .digest('hex');

    const result = await strapi
      .service('api::store.entity-page' as any)
      .submitRating(entityType, slug, value, ipHash);
    if (!result) {
      return ctx.notFound(`${entityType} not found`);
    }
    if (result.alreadyVoted) {
      return ctx.tooManyRequests(`You have already rated this ${entityType}.`);
    }

    return ctx.send({
      ok: true,
      ratingAverage: result.ratingAverage,
      ratingCount: result.ratingCount,
    });
  },
});
