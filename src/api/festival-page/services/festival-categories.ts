import type { Core } from '@strapi/strapi';
import { brandRef, categoryRef, storeRef, isLiveOffer, hasSafeAffiliateLink, sanitizeOutput, NEWEST_FIRST, PUBLISHED_OFFER_FILTER } from '../../../utils/offer-visibility';

export const FESTIVAL_CATEGORY_COUPON = {
  fields: ['title', 'content', 'offerText', 'code', 'couponType', 'affiliateLink', 'checkoutMerchant', 'isForAffiliateBrand', 'expiresAt', 'contentStatus', 'publishedOn', 'publishedAt', 'cashbackText', 'bankOfferText', 'prepaidText', 'badge', 'usesCurrencyAmounts', 'currencyCode', 'offerCountries'],
  populate: { stores: storeRef, logoStore: storeRef, brands: brandRef, categories: categoryRef, banks: { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } }, uniqueCouponPool: { fields: ['name'] } },
};
export const FESTIVAL_CATEGORIES_POPULATE = {
  populate: { categories: { populate: { category: categoryRef, imageOverride: true, coupons: FESTIVAL_CATEGORY_COUPON } } },
};

/** Fetch the complete fallback catalogue in batches, once for all empty categories.
 * An explicit selection containing only expired Coupons must not become a fallback.
 */
export async function resolveFestivalCategories(strapi: Core.Strapi, ctx: any, section: any, locale: string, now = new Date()) {
  if (!section || section.enabled === false || !Array.isArray(section.categories)) return;
  const rows = section.categories.filter((row: any) => row.category?.documentId);
  section.categories = rows;
  const emptyIds = new Set<string>(rows.filter((row: any) => !row.coupons?.length).map((row: any) => row.category.documentId));
  const byCategory = new Map<string, any[]>([...emptyIds].map((id) => [id, []]));
  const live = (offer: any) => isLiveOffer(offer, now) && hasSafeAffiliateLink(offer.affiliateLink);
  if (emptyIds.size) {
    const seen = new Set<string>();
    for (let start = 0; ; start += 100) {
      const batch = await strapi.documents('api::coupon.coupon').findMany({
        locale, ...FESTIVAL_CATEGORY_COUPON,
        filters: { ...PUBLISHED_OFFER_FILTER, categories: { documentId: { $in: [...emptyIds] } } },
        sort: [...NEWEST_FIRST, 'documentId:asc'], start, limit: 100,
      } as any);
      const safe = await sanitizeOutput(strapi, ctx, 'api::coupon.coupon', batch);
      for (const offer of safe) {
        if (!offer.documentId || seen.has(offer.documentId) || !live(offer)) continue;
        seen.add(offer.documentId);
        for (const category of offer.categories ?? []) byCategory.get(category.documentId)?.push(offer);
      }
      if (batch.length < 100) break;
    }
  }
  for (const row of rows) {
    const source = row.coupons?.length ? row.coupons : byCategory.get(row.category.documentId) ?? [];
    const seen = new Set<string>();
    row.coupons = source.filter((offer: any) => {
      if (!offer.documentId || seen.has(offer.documentId) || !live(offer)) return false;
      seen.add(offer.documentId);
      return true;
    });
  }
}
