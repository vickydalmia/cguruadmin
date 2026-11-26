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
import { addCampaignCategoryRows, applyCategoryCouponOrders, BLACK_FRIDAY_CAMPAIGN_CATEGORY_FILTERS, BLACK_FRIDAY_POPULATE, blackFridayDealCategorySlug, curatedCategoryRows, limitListingDeals, loadCategoryCouponOrders, selectCampaignCategories } from '../services/black-friday-content';

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
      const candidates = await strapi.documents('api::category.category').findMany({ locale, ...categoryRef, fields: [...categoryRef.fields, 'pageTemplate'], filters: BLACK_FRIDAY_CAMPAIGN_CATEGORY_FILTERS } as any);
      const selected = selectCampaignCategories(candidates);
      const publicCategories = await sanitizeOutput(strapi, ctx, 'api::category.category', selected.map(({ category }) => category));
      const campaignCategories = selected.map(({ campaign }, index) => ({ campaign, category: publicCategories[index] }));
      addCampaignCategoryRows(data.exploreCategories, campaignCategories);
      const curated = curatedCategoryRows(data.exploreCategories);
      await resolveFestivalCategories(strapi, ctx, data.exploreCategories, locale, now);
      applyCategoryCouponOrders(data.exploreCategories, curated, await loadCategoryCouponOrders(strapi, data.exploreCategories, curated, locale));
      await resolveFestivalDealListing(strapi, ctx, data.productSection, locale, now, data.filterDealsByBlackFriday === true ? blackFridayDealCategorySlug(campaignCategories) : undefined);
      limitListingDeals(data.productSection);
    }
    arrayizeOfferText(data);
    await attachFestiveOffers(strapi, data);
    await attachStablePublicOfferIdsForRequest(strapi, ctx, data);
    return ctx.send({ data });
  },
});
