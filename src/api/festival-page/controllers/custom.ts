import type { Core } from '@strapi/strapi';
import { FESTIVAL_PAGE_UID } from '../../../constants/festival-page';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';
import { sanitizeOutput } from '../../../utils/offer-visibility';
import { FESTIVAL_POPULATE } from '../services/festival-content';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async festivalFull(ctx) {
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page = await strapi.documents(FESTIVAL_PAGE_UID).findFirst({
      locale, populate: FESTIVAL_POPULATE,
    });
    if (!page) return ctx.notFound('Festival page not found');
    return ctx.send({ data: await sanitizeOutput(strapi, ctx, FESTIVAL_PAGE_UID, page) });
  },
});
