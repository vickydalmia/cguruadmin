import type { Core } from '@strapi/strapi';

// Shared visibility/actionability rules, populate refs, and the curated-list
// backfill driver for the public offer aggregates (/homepage-full,
// /deal-of-the-day-full). One home for these invariants so a fix (e.g. to the
// affiliate-link safety check) lands in every endpoint at once.

export const PUBLISHED_OFFER_FILTER = { contentStatus: { $eq: 'published' } } as const;
export const NEWEST_FIRST = ['publishedAt:desc'] as const;

// Fallback queries fetch a buffer above what any section renders so the
// actionability filter below can discard invalid records without starving
// the visible slots.
export const BACKFILL_QUERY_LIMIT = 40;

export const STORE_FIELDS = ['name', 'slug', 'logoAlt'];
export const CATEGORY_FIELDS = ['name', 'slug'];
export const BRAND_FIELDS = ['name', 'slug', 'logoAlt'];

export const DEAL_FIELDS = [
  'title',
  'content',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'code',
  'salePrice',
  'mrp',
  'discount',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
];

export const storeRef = { fields: STORE_FIELDS, populate: { logo: true } };
export const categoryRef = { fields: CATEGORY_FIELDS, populate: { icon: true } };
export const brandRef = { fields: BRAND_FIELDS, populate: { logo: true } };

export const dealRef = {
  fields: DEAL_FIELDS,
  populate: {
    dealImage: true,
    primaryStore: storeRef,
    stores: storeRef,
    brands: brandRef,
  },
};

// Published AND not past its expiresAt: the populate filter only checks
// contentStatus, which the 5-minute cron may not have flipped yet.
export const isLiveOffer = (offer: any, now: Date) =>
  offer?.contentStatus === 'published' &&
  (!offer.expiresAt || new Date(offer.expiresAt) > now);

export function hasSafeAffiliateLink(value: unknown) {
  if (typeof value !== 'string') return false;
  const href = value.trim();
  if (!href) return false;
  if (href.startsWith('/') && !href.startsWith('//')) return true;

  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isActionableProductDeal(deal: any, now: Date) {
  const rawPrice =
    typeof deal?.salePrice === 'string'
      ? deal.salePrice.replaceAll(',', '').trim()
      : deal?.salePrice;
  const salePrice = Number(rawPrice);

  return (
    isLiveOffer(deal, now) &&
    typeof deal?.dealImage?.url === 'string' &&
    deal.dealImage.url.trim().length > 0 &&
    Number.isFinite(salePrice) &&
    salePrice > 0 &&
    hasSafeAffiliateLink(deal?.affiliateLink)
  );
}

export const cap = (arr: any, limit: number) =>
  Array.isArray(arr) ? arr.slice(0, limit) : arr;

export async function sanitizeOutput(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  data: any,
): Promise<any> {
  const schema = strapi.contentType(uid as any) as any;
  return await strapi.contentAPI.sanitize.output(data, schema, { auth: ctx.state.auth });
}

// Shared backfill driver: keep valid curated deals in editor order, then fill
// the remaining visible slots from recent Deal-schema records matching
// `filters`. Coupon records never enter these sections. Mutates `holder.deals`.
export async function backfillDeals(
  strapi: Core.Strapi,
  ctx: any,
  holder: any,
  {
    filters,
    renderCount,
    capLimit,
    now,
    accept = () => true,
  }: {
    filters: Record<string, unknown>;
    renderCount: number;
    capLimit: number;
    now: Date;
    accept?: (deal: any) => boolean;
  },
) {
  const curated = Array.isArray(holder.deals)
    ? holder.deals.filter(
        (deal: any) => isActionableProductDeal(deal, now) && accept(deal),
      )
    : [];
  holder.deals = curated;

  if (curated.length >= renderCount) return;

  const recentDeals = await strapi.documents('api::deal.deal').findMany({
    filters: {
      ...PUBLISHED_OFFER_FILTER,
      salePrice: { $notNull: true, $gt: 0 },
      ...filters,
    },
    fields: DEAL_FIELDS,
    populate: dealRef.populate,
    sort: NEWEST_FIRST,
    limit: BACKFILL_QUERY_LIMIT,
  } as any);
  const sanitizedDeals = await sanitizeOutput(strapi, ctx, 'api::deal.deal', recentDeals);
  const seen = new Set(curated.map((deal: any) => deal?.documentId).filter(Boolean));

  for (const deal of Array.isArray(sanitizedDeals) ? sanitizedDeals : []) {
    if (!isActionableProductDeal(deal, now) || !accept(deal) || seen.has(deal.documentId)) {
      continue;
    }
    holder.deals.push(deal);
    if (deal.documentId) seen.add(deal.documentId);
    if (holder.deals.length >= capLimit) break;
  }
}
