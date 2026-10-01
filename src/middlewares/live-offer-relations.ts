import { festivalFilterTarget, runWithFestivalFilter, liveFestivalFilterIds } from '../api/festival-page/services/festival-admin-filters';
import type { Core } from '@strapi/strapi';
import {
  curatedOfferTargetForRelationPath,
  isContentManagerRelationPath,
  normalizeRelationSearch,
  runWithCuratedOfferRelationFilter,
} from '../utils/curated-offer-live-filter';

/**
 * Normalizes the relation-picker search term for every Content Manager
 * relation endpoint, then marks only the curated Coupon/Deal picker requests.
 * The request-local marker is consumed by the Query Engine lifecycle
 * subscriber, leaving normal Coupon and Product Deal Content Manager lists
 * untouched.
 */
export default (
  _config: unknown,
  { strapi }: { strapi: Core.Strapi },
) => {
  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.method !== 'GET') return next();
    if (!isContentManagerRelationPath(ctx.path)) return next();

    if (ctx.request?.query && '_q' in ctx.request.query) {
      ctx.request.query._q = normalizeRelationSearch(ctx.request.query._q);
    }

    const festivalTarget=festivalFilterTarget(ctx.path);
    if(festivalTarget){
      const locale=ctx.query?.locale??ctx.query?.plugins?.i18n?.locale;
      const ids=await liveFestivalFilterIds(strapi,festivalTarget,typeof locale==='string'?locale:'en');
      return runWithFestivalFilter(festivalTarget,ids,next);
    }
    const targetUid = curatedOfferTargetForRelationPath(strapi, ctx.path);
    if (!targetUid) return next();

    return runWithCuratedOfferRelationFilter(targetUid, next);
  };
};
