import type { Core } from '@strapi/strapi';
import {
  INDEPENDENCE_DAY_SALE_CAPS,
  INDEPENDENCE_DAY_SALE_UID,
} from '../../../constants/independence-day-sale-sections';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import {
  BACKFILL_QUERY_LIMIT,
  NEWEST_FIRST,
  PUBLISHED_OFFER_FILTER,
  brandRef,
  cap,
  categoryRef,
  dealRef,
  hasSafeAffiliateLink,
  isActionableProductDeal,
  isLiveOffer,
  latestActionableCatalog,
  sanitizeOutput,
  storeRef,
} from '../../../utils/offer-visibility';


import { PAGE_POPULATE } from './independence-day-sale-populate';
import { fillSections, sectionActive } from './independence-day-sale-transforms';
import {
  attachStablePublicOfferIdsForRequest,
  requestedOfferTargetLocale,
} from '../../coupon/services/public-offer-ids';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async independenceDaySaleFull(ctx: any) {
    // Same contract as the homepage: the storefront sends ?locale= for a
    // localized render and the default-locale row serves everything else.
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page = await strapi
      .documents(INDEPENDENCE_DAY_SALE_UID as any)
      .findFirst({ locale, populate: PAGE_POPULATE as any });

    if (!page) return ctx.notFound('Independence Day sale page not found');

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      INDEPENDENCE_DAY_SALE_UID,
      page,
    );
    await fillSections(strapi, ctx, sanitized);
    arrayizeOfferText(sanitized);
    await attachFestiveOffers(strapi, sanitized);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, sanitized);

    return ctx.send({ data: sanitized });
  },
});
