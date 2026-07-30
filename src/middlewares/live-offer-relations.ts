import type { Core } from '@strapi/strapi';
import {
  curatedOfferTargetForRelationPath,
  normalizeCuratedRelationSearch,
  runWithCuratedOfferRelationFilter,
} from '../utils/curated-offer-relations';

/**
 * Marks only the Homepage / Deal of the Day relation-picker request. The
 * request-local marker is consumed by the Query Engine lifecycle subscriber,
 * leaving normal Coupon and Product Deal Content Manager lists untouched.
 */
export default (
  _config: unknown,
  { strapi: _strapi }: { strapi: Core.Strapi },
) => {
  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.method !== 'GET') return next();

    const targetUid = curatedOfferTargetForRelationPath(ctx.path);
    if (!targetUid) return next();

    if (ctx.request?.query && '_q' in ctx.request.query) {
      ctx.request.query._q = normalizeCuratedRelationSearch(
        ctx.request.query._q,
      );
    }

    return runWithCuratedOfferRelationFilter(targetUid, next);
  };
};
