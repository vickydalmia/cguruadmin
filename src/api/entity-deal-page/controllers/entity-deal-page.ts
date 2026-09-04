import type { Core } from '@strapi/strapi';
import { attachStablePublicOfferIdsForRequest } from '../../coupon/services/public-offer-ids';
import { requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async publicFind(ctx: any) {
    const service = strapi.service(
      'api::entity-deal-page.entity-deal-page',
    ) as any;
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const result = await service.getPublicPage(ctx.params?.dealSlug, {
      ...ctx.query,
      locale,
    });
    if (!result) return ctx.notFound('Entity Deal page not found');
    await attachStablePublicOfferIdsForRequest(strapi, ctx, result, ['deal']);
    return ctx.send(result);
  },

  async publicRoutes(ctx: any) {
    const service = strapi.service(
      'api::entity-deal-page.entity-deal-page',
    ) as any;
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    return ctx.send(await service.listPublicRoutes(locale));
  },

  async adminList(ctx: any) {
    const service = strapi.service(
      'api::entity-deal-page.entity-deal-page',
    ) as any;
    return ctx.send(await service.listSettings(ctx.query));
  },

  async adminUpdate(ctx: any) {
    const service = strapi.service(
      'api::entity-deal-page.entity-deal-page',
    ) as any;
    const result = await service.updateSettings(
      ctx.params?.kind,
      ctx.params?.documentId,
      ctx.request?.body?.data ?? ctx.request?.body,
    );
    if (!result) return ctx.notFound('Entity not found');
    return ctx.send(result);
  },
});
