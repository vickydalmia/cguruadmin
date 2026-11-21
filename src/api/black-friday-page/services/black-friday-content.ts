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

const BLACK_FRIDAY_TEMPLATE = 'blackFridayTemplate';
/** Country sites keep different slugs for the same seasonal categories, in match priority. */
const CAMPAIGN_SLUGS = {
  'black-friday': ['black-friday-coupons', 'blackfriday-coupons', 'black-friday', 'blackfriday'],
  'cyber-monday': ['cyber-monday-coupons', 'cybermonday-coupons', 'cyber-monday', 'cybermonday'],
} as const;
type Campaign = keyof typeof CAMPAIGN_SLUGS;
export type CampaignCategory = { campaign: Campaign; category: any };

export const BLACK_FRIDAY_CAMPAIGN_CATEGORY_FILTERS = {
  $or: [
    { pageTemplate: { $eq: BLACK_FRIDAY_TEMPLATE } },
    { slug: { $in: Object.values(CAMPAIGN_SLUGS).flat() } },
  ],
};

const bySlug = (categories: any[], campaign: Campaign) => CAMPAIGN_SLUGS[campaign]
  .map((slug) => categories.find((category) => category?.slug === slug))
  .find(Boolean);

/** The category using this template is Black Friday; known slugs cover a template assigned elsewhere. */
export function selectCampaignCategories(categories: any[]): CampaignCategory[] {
  const cyberMonday = bySlug(categories, 'cyber-monday');
  const assigned = categories.find((category) => category?.pageTemplate === BLACK_FRIDAY_TEMPLATE && category !== cyberMonday);
  const blackFriday = assigned ?? bySlug(categories, 'black-friday');
  return [
    ...(blackFriday ? [{ campaign: 'black-friday' as const, category: blackFriday }] : []),
    ...(cyberMonday ? [{ campaign: 'cyber-monday' as const, category: cyberMonday }] : []),
  ].map(({ campaign, category }) => {
    const { pageTemplate: _pageTemplate, ...publicCategory } = category;
    return { campaign, category: publicCategory };
  });
}

/** With filterDealsByBlackFriday on, no resolved category means no Deals, never every Deal. */
export function blackFridayDealCategorySlug(categories: CampaignCategory[]): string {
  return categories.find(({ campaign }) => campaign === 'black-friday')?.category?.slug ?? CAMPAIGN_SLUGS['black-friday'][0];
}

export function addCampaignCategoryRows(section: any, categories: CampaignCategory[]): void {
  if (!section || section.enabled === false || !Array.isArray(section.categories)) return;
  for (const { campaign, category } of categories) {
    if (!category?.documentId) continue;
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
