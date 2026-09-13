import type { Core } from '@strapi/strapi';
import { requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { sanitizeOutput } from '../../../utils/offer-visibility';
import { SUBSCRIPTION_PAGE_UID, subscriptionPath } from '../services/subscription-route';
import { SUBSCRIPTION_POPULATE } from './subscription-populate';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async subscriptionPageFull(ctx) {
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page: any = await strapi.documents(SUBSCRIPTION_PAGE_UID as any).findFirst({
      locale, populate: SUBSCRIPTION_POPULATE as any,
    });
    if (page?.enabled !== true || !subscriptionPath(page)) return ctx.send({ data: null });
    const sanitized = await sanitizeOutput(strapi, ctx, SUBSCRIPTION_PAGE_UID, page);
    return ctx.send({ data: sanitized });
  },
});
