import type { Core } from '@strapi/strapi';
import { dealRef, NEWEST_FIRST, PUBLISHED_OFFER_FILTER, isLiveOffer, hasSafeAffiliateLink, sanitizeOutput } from '../../../utils/offer-visibility';

/** One catalogue for all filters, never a query per brand/store. */
export async function resolveFestivalDealListing(strapi: Core.Strapi, ctx: any, section: any, locale: string, now = new Date()) {
  if (!section || section.enabled === false) return;
  const categoryIds = [...new Set<string>((section.categories ?? []).map(row => row.category?.documentId).filter(Boolean))];
  section.listingDeals = [];
  if (!categoryIds.length) return;
  const deals: any[] = [];
  const seen = new Set<string>();
  for (let start = 0; ; start += 100) {
    const batch = await strapi.documents('api::deal.deal').findMany({
      locale, ...dealRef,
      populate: { ...dealRef.populate, banks: { fields: ['name', 'slug'] }, categories: { fields: ['name'] } },
      filters: { ...PUBLISHED_OFFER_FILTER, categories: { documentId: { $in: categoryIds } }, $or: [{ expiresAt: { $null: true } }, { expiresAt: { $gt: now.toISOString() } }] },
      sort: [...NEWEST_FIRST, 'documentId:asc'], start, limit: 100,
    } as any);
    const safe = await sanitizeOutput(strapi, ctx, 'api::deal.deal', batch);
    for (const deal of safe) {
      if (!deal.documentId || seen.has(deal.documentId) || !isLiveOffer(deal, now) || !hasSafeAffiliateLink(deal.affiliateLink) || !deal.dealImage?.url) continue;
      seen.add(deal.documentId);
      deals.push(deal);
    }
    if (batch.length < 100) break;
  }
  section.listingDeals = deals;
}
