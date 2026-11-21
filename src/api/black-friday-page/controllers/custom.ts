import type { Core } from '@strapi/strapi';
import { BLACK_FRIDAY_PAGE_UID } from '../../../constants/black-friday-page';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { categoryRef } from '../../../utils/offer-visibility';
import { hasSafeAffiliateLink, isLiveOffer, sanitizeOutput } from '../../../utils/offer-visibility';
import { attachStablePublicOfferIdsForRequest, requestedOfferTargetLocale } from '../../coupon/services/public-offer-ids';
import { resolveFestivalCategories } from '../../festival-page/services/festival-categories';
import { resolveFestivalDealListing } from '../../festival-page/services/festival-deal-listing';
import { addCampaignCategoryRows, BLACK_FRIDAY_CAMPAIGN_CATEGORIES, BLACK_FRIDAY_POPULATE, curatedCategoryRows, limitAutomaticCoupons, limitListingDeals } from '../services/black-friday-content';

const liveSafe = (offer: any, now: Date) => isLiveOffer(offer, now) && hasSafeAffiliateLink(offer?.affiliateLink);

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async blackFridayFull(ctx) {
    const locale = requestedOfferTargetLocale(ctx) ?? DEFAULT_CONTENT_LOCALE;
    const page = await strapi.documents(BLACK_FRIDAY_PAGE_UID as any).findFirst({ locale, populate: BLACK_FRIDAY_POPULATE as any });
    if (!page) return ctx.notFound('Black Friday page not found');
    const data = await sanitizeOutput(strapi, ctx, BLACK_FRIDAY_PAGE_UID, page);
    const now = new Date();
    if (Array.isArray(data.featured?.items)) data.featured.items = data.featured.items.filter((item: any) => liveSafe(item.coupon, now));
    if (Array.isArray(data.productSection?.items)) data.productSection.items = data.productSection.items.filter((item: any) => liveSafe(item.deal, now));
    if (data.enabled === true) {
      const campaignCategories = await strapi.documents('api::category.category').findMany({ locale, ...categoryRef, filters: { slug: { $in: Object.keys(BLACK_FRIDAY_CAMPAIGN_CATEGORIES) } } } as any);
      addCampaignCategoryRows(data.exploreCategories, await sanitizeOutput(strapi, ctx, 'api::category.category', campaignCategories));
      const curated = curatedCategoryRows(data.exploreCategories);
      await resolveFestivalCategories(strapi, ctx, data.exploreCategories, locale, now);
      limitAutomaticCoupons(data.exploreCategories, curated);
      await resolveFestivalDealListing(strapi, ctx, data.productSection, locale, now);
      limitListingDeals(data.productSection);
    }
    arrayizeOfferText(data);
    await attachFestiveOffers(strapi, data);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, data);
    return ctx.send({ data });
  },
});
