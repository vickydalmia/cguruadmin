import { FESTIVAL_CATEGORIES_POPULATE, FESTIVAL_CATEGORY_COUPON } from '../../festival-page/services/festival-categories';
import { brandRef, categoryRef, dealRef, PUBLISHED_OFFER_FILTER, storeRef } from '../../../utils/offer-visibility';
import { ORDERED_COUPON_LIMIT } from '../../../api/entity-coupon-layout/services/entity-coupon-layout-parse';

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

/** Product Deal listings ship in the page HTML, so each category keeps its newest Deals only. */
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

const TOP_PICK_LIMIT = 4;
const documentIds = (rows: unknown, limit: number): string[] => (Array.isArray(rows) ? rows : [])
  .map((row: any) => row?.documentId)
  .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
  .slice(0, limit);

/** Each automatic category's saved page order: Top Picks, then Ordered Coupons. */
export async function loadCategoryCouponOrders(strapi: any, section: any, curated: ReadonlySet<unknown>, locale: string): Promise<Map<string, string[]>> {
  const ids = [...new Set<string>((section?.categories ?? [])
    .filter((row: any) => !curated.has(row))
    .map((row: any) => row?.category?.documentId)
    .filter(Boolean))];
  if (!ids.length) return new Map();
  const categories = await strapi.documents('api::category.category').findMany({
    locale,
    filters: { documentId: { $in: ids } },
    fields: ['documentId'],
    populate: { topPickCoupons: { fields: ['documentId'] }, orderedCoupons: { fields: ['documentId'] } },
    limit: ids.length,
  });
  return new Map((categories ?? []).map((category: any) => [category.documentId, [
    ...documentIds(category.topPickCoupons, TOP_PICK_LIMIT),
    ...documentIds(category.orderedCoupons, ORDERED_COUPON_LIMIT),
  ]]));
}

/** Saved coupons lead in their saved order; the remaining coupons stay newest first. */
export function applyCategoryCouponOrders(section: any, curated: ReadonlySet<unknown>, orders: ReadonlyMap<string, readonly string[]>): void {
  for (const row of section?.categories ?? []) {
    const order = orders.get(row?.category?.documentId);
    if (curated.has(row) || !order?.length || !Array.isArray(row.coupons)) continue;
    const byId = new Map(row.coupons.map((coupon: any) => [coupon.documentId, coupon]));
    const lead = [...new Set(order)].flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
    const leading = new Set(lead);
    row.coupons = [...lead, ...row.coupons.filter((coupon: any) => !leading.has(coupon))];
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
