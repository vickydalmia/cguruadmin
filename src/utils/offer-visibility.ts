import type { Core } from '@strapi/strapi';
import { AMAZON_AFFILIATE_DISCLOSURE_FIELD } from './amazon-affiliate-disclosure';

// Shared visibility/actionability rules, populate refs, and the curated-list
// backfill driver for the public offer aggregates (/homepage-full,
// /deal-of-the-day-full). One home for these invariants so a fix (e.g. to the
// affiliate-link safety check) lands in every endpoint at once.

export const PUBLISHED_OFFER_FILTER = { contentStatus: { $eq: 'published' } } as const;
// `publishedOn` is the EDITOR-CONTROLLED sort key: re-dating an offer in the
// admin (or hitting "Bump to top") resurfaces it here. Strapi's own
// `publishedAt` — stamped once at creation, not editable under
// `draftAndPublish: false` — stays only as a tiebreaker for any row the
// backfill migration could not seed.
export const NEWEST_FIRST = ['publishedOn:desc', 'publishedAt:desc'] as const;

// Fallback queries fetch a buffer above what any section renders so the
// actionability filter below can discard invalid records without starving
// the visible slots.
export const BACKFILL_QUERY_LIMIT = 40;

export const STORE_FIELDS = ['name', 'slug', 'logoAlt'];
// `iconAlt` is category's counterpart to logoAlt on store/brand/bank — it is
// required in the schema, so it must actually reach the site or editors are
// filling a field nothing renders.
export const CATEGORY_FIELDS = ['name', 'slug', 'iconAlt'];
export const BRAND_FIELDS = ['name', 'slug', 'logoAlt'];

export const DEAL_FIELDS = [
  'title',
  'content',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
  'badge',
  'code',
  // Load-bearing alongside `code`: the frontend exposes a code only for a
  // KNOWN code type, so a Deal projection that omits `couponType` renders every
  // Deal as a no-code offer.
  'couponType',
  'salePrice',
  'mrp',
  'discount',
  'discountPrefix',
  'affiliateLink',
  // Read by the festive-offer walker, which strips it from the response before
  // it reaches the UI (see src/utils/festive-offer-response.ts).
  'checkoutMerchant',
  // Affiliate-brand offers render the BRAND logo in their merchant chip.
  'isForAffiliateBrand',
  // Csv of offer-country registry codes — flag tags on the cards.
  'offerCountries',
  // Consumed and removed by arrayizeOfferText after it derives the final
  // Amazon Creator Connections condition.
  AMAZON_AFFILIATE_DISCLOSURE_FIELD,
  'expiresAt',
  'contentStatus',
  'publishedOn',
];

export const storeRef = { fields: STORE_FIELDS, populate: { logo: true } };
export const categoryRef = { fields: CATEGORY_FIELDS, populate: { icon: true } };
export const brandRef = { fields: BRAND_FIELDS, populate: { logo: true } };

export const dealRef = {
  fields: DEAL_FIELDS,
  populate: {
    dealImage: true,
    logoStore: storeRef,
    stores: storeRef,
    brands: brandRef,
    // Name only. The pool documentId (always emitted alongside the selected
    // fields) is what lets the frontend render the unique-code flow; the
    // allocated codes themselves stay behind /unique-coupon/redeem.
    uniqueCouponPool: { fields: ['name'] },
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
  return (
    isLiveOffer(deal, now) &&
    typeof deal?.dealImage?.url === 'string' &&
    deal.dealImage.url.trim().length > 0 &&
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

const CATALOG_QUERY_BATCH_SIZE = 100;

// Collect a fixed number of valid newest-first records even when the first
// query batch contains expired or otherwise unusable entries. Independence
// Day and Deal of the Day share this driver so their "selected, otherwise
// latest" sections cannot drift apart.
export async function latestActionableCatalog(
  strapi: Core.Strapi,
  ctx: any,
  {
    uid,
    fields,
    populate,
    limit,
    now,
    accept,
  }: {
    uid: 'api::coupon.coupon' | 'api::deal.deal';
    fields: readonly string[];
    populate: Record<string, unknown>;
    limit: number;
    now: Date;
    accept: (item: any, now: Date) => boolean;
  },
): Promise<any[]> {
  const accepted: any[] = [];
  const seen = new Set<string>();
  let start = 0;

  while (accepted.length < limit) {
    const rows = await strapi.documents(uid).findMany({
      filters: PUBLISHED_OFFER_FILTER,
      fields: fields as any,
      populate: populate as any,
      sort: NEWEST_FIRST as any,
      start,
      limit: CATALOG_QUERY_BATCH_SIZE,
    } as any);
    const batch = Array.isArray(rows) ? rows : [];
    if (batch.length === 0) break;

    const sanitized = await sanitizeOutput(strapi, ctx, uid, batch);
    for (const item of Array.isArray(sanitized) ? sanitized : []) {
      const documentId = item?.documentId;
      if (!documentId || seen.has(documentId) || !accept(item, now)) continue;
      accepted.push(item);
      seen.add(documentId);
      if (accepted.length >= limit) break;
    }

    if (batch.length < CATALOG_QUERY_BATCH_SIZE) break;
    start += batch.length;
  }

  return accepted;
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
