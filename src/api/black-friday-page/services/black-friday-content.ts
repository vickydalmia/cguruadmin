import { FESTIVAL_CATEGORIES_POPULATE, FESTIVAL_CATEGORY_COUPON } from '../../festival-page/services/festival-categories';
import { brandRef, categoryRef, dealRef, PUBLISHED_OFFER_FILTER, storeRef } from '../../../utils/offer-visibility';

export const BLACK_FRIDAY_POPULATE = {
  hero: { populate: { tickets: { populate: { store: storeRef, brand: brandRef } } } },
  ticker: true,
  topBrands: { populate: { items: { populate: { store: storeRef, brand: brandRef } } } },
  featured: { populate: { items: { populate: { coupon: { ...FESTIVAL_CATEGORY_COUPON, filters: PUBLISHED_OFFER_FILTER }, imageOverride: true } } } },
  exploreCategories: FESTIVAL_CATEGORIES_POPULATE,
  productSection: { populate: { items: { populate: { deal: { ...dealRef, filters: PUBLISHED_OFFER_FILTER } } }, categories: { populate: { category: categoryRef, imageOverride: true } } } },
  faq: { populate: { items: true } },
  popularSearches: { populate: { stores: { fields: ['name', 'slug'] }, brands: { fields: ['name', 'slug'] }, categories: { fields: ['name', 'slug'] }, banks: { fields: ['name', 'slug'] } } },
} as const;

/** Activation is explicit and independent of optional section content. */
export function blackFridayTemplateEnabled(row: { enabled?: boolean | null } | null): boolean {
  return row?.enabled === true;
}

/** Automatic listings ship in the page HTML, so each category keeps its newest offers only. */
export const BLACK_FRIDAY_LISTING_LIMIT = 24;

/** With filterDealsByBlackFriday on, Product Deals must also be in this category. */
export const BLACK_FRIDAY_DEAL_CATEGORY_SLUG = 'black-friday-coupons';

/** Quick-filter pills read these existing categories by their stable slugs. */
export const BLACK_FRIDAY_CAMPAIGN_CATEGORIES = { 'black-friday-coupons': 'black-friday', 'cyber-monday-coupons': 'cyber-monday' } as const;

export function addCampaignCategoryRows(section: any, categories: any[]): void {
  if (!section || section.enabled === false || !Array.isArray(section.categories)) return;
  for (const category of categories) {
    const campaign = BLACK_FRIDAY_CAMPAIGN_CATEGORIES[category?.slug as keyof typeof BLACK_FRIDAY_CAMPAIGN_CATEGORIES];
    if (!campaign || !category.documentId) continue;
    const existing = section.categories.find((row: any) => row.category?.documentId === category.documentId);
    if (existing) existing.campaign = campaign;
    else section.categories.push({ category, coupons: [], campaign, campaignOnly: true });
  }
}

export function curatedCategoryRows(section: any): Set<unknown> {
  return new Set((section?.categories ?? []).filter((row: any) => row?.coupons?.length));
}

export function limitAutomaticCoupons(section: any, curated: ReadonlySet<unknown>, limit = BLACK_FRIDAY_LISTING_LIMIT): void {
  for (const row of section?.categories ?? []) {
    if (!curated.has(row) && Array.isArray(row.coupons)) row.coupons = row.coupons.slice(0, limit);
  }
}

export function limitListingDeals(section: any, limit = BLACK_FRIDAY_LISTING_LIMIT): void {
  if (!Array.isArray(section?.listingDeals)) return;
  const selected = new Set((section.categories ?? []).map((row: any) => row.category?.documentId).filter(Boolean));
  const counts = new Map<string, number>();
  section.listingDeals = section.listingDeals.filter((deal: any) => {
    const ids = (deal.categories ?? []).map((category: any) => category.documentId).filter((id: string) => selected.has(id));
    if (!ids.some((id: string) => (counts.get(id) ?? 0) < limit)) return false;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return true;
  });
}
