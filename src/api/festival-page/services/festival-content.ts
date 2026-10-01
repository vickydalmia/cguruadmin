import { FESTIVAL_CATEGORIES_POPULATE } from './festival-categories';
import { brandRef, categoryRef, storeRef, dealRef, PUBLISHED_OFFER_FILTER } from '../../../utils/offer-visibility';

export const FESTIVAL_POPULATE = {
  productSection: { populate: { filterBrands: { fields: ['name'] }, filterStores: { fields: ['name'] }, filterBanks: { fields: ['name'] }, items: { populate: { deal: { ...dealRef, filters: PUBLISHED_OFFER_FILTER } } }, categories: { populate: { category: categoryRef, imageOverride: true } } } },
  exploreCategories: FESTIVAL_CATEGORIES_POPULATE,
  faq: { populate: { items: true } },
  popularSearches: { populate: { stores: { fields: ['name', 'slug'] }, brands: { fields: ['name', 'slug'] }, categories: { fields: ['name', 'slug'] }, banks: { fields: ['name', 'slug'] } } },
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
