import { FESTIVAL_CATEGORIES_POPULATE } from './festival-categories';
import { brandRef, categoryRef, storeRef, PUBLISHED_OFFER_FILTER } from '../../../utils/offer-visibility';

export const FESTIVAL_POPULATE = {
  exploreCategories: FESTIVAL_CATEGORIES_POPULATE,
  countdown: true,
  hero: { populate: { desktopImage: true } },
  offerSlider: { populate: { items: { populate: {
    coupon: { filters: PUBLISHED_OFFER_FILTER, fields: ['title', 'content', 'offerText', 'code', 'couponType', 'affiliateLink', 'checkoutMerchant', 'isForAffiliateBrand', 'expiresAt', 'contentStatus'],
      populate: { stores: storeRef, logoStore: storeRef, brands: brandRef, categories: categoryRef, banks: { fields: ['name', 'slug', 'logoAlt'], populate: { logo: true } }, uniqueCouponPool: { fields: ['name'] } } },
  } } } },
  seo: { populate: { ogImage: true } },
} as const;

/** Activation is explicit and independent of optional section content. */
export function festivalTemplateEnabled(row: { enabled?: boolean | null } | null): boolean {
  return row?.enabled === true;
}
