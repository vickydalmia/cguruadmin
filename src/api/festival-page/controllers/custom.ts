import { resolveFestivalDealListing } from '../services/festival-deal-listing';
import { resolveFestivalCategories } from '../services/festival-categories';
import type { Core } from '@strapi/strapi';
import { FESTIVAL_PAGE_UID } from '../../../constants/festival-page';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import { isLiveOffer, hasSafeAffiliateLink } from '../../../utils/offer-visibility';
import { attachStablePublicOfferIdsForRequest, requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';
import { sanitizeOutput } from '../../../utils/offer-visibility';
import { FESTIVAL_POPULATE } from '../services/festival-content';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async festivalFull(ctx) {
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page = await strapi.documents(FESTIVAL_PAGE_UID).findFirst({
      locale, populate: FESTIVAL_POPULATE as any,
    });
    if (!page) return ctx.notFound('Festival page not found');
    const data = await sanitizeOutput(strapi, ctx, FESTIVAL_PAGE_UID, page);
    if (Array.isArray(data.offerSlider?.items)) {
      data.offerSlider.items = data.offerSlider.items.filter((item: any) => {
        const offer = item.coupon;
        return isLiveOffer(offer, new Date()) && hasSafeAffiliateLink(offer.affiliateLink);
      });
    }
    if (Array.isArray(data.productSection?.items)) {
      data.productSection.items = data.productSection.items.filter((item: any) => isLiveOffer(item.deal, new Date()) && hasSafeAffiliateLink(item.deal.affiliateLink));
    }
    await resolveFestivalCategories(strapi, ctx, data.exploreCategories, locale);
    if (data.enabled === true) await resolveFestivalDealListing(strapi, ctx, data.productSection, locale);
    arrayizeOfferText(data);
    await attachFestiveOffers(strapi, data);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, data);
    return ctx.send({ data });
  },
});
