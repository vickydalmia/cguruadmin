// Independence Day Sale SECTION TRANSFORMS: actionable-coupon filtering,
// dedupe, recent-offer fallbacks and the holder/section fills. Split out of
// ./custom.ts, which keeps the load -> sanitize -> transform -> send flow.
import type { Core } from '@strapi/strapi';
import { INDEPENDENCE_DAY_SALE_CAPS } from '../../../constants/independence-day-sale-sections';
import {
  BACKFILL_QUERY_LIMIT,
  NEWEST_FIRST,
  PUBLISHED_OFFER_FILTER,
  cap,
  hasSafeAffiliateLink,
  isActionableProductDeal,
  isLiveOffer,
  dealRef,
  latestActionableCatalog,
  sanitizeOutput,
} from '../../../utils/offer-visibility';
import { COUPON_FIELDS, couponRef } from './independence-day-sale-populate';

export const sectionActive = (section: any) => section && section.enabled !== false;

function couponIdentity(coupon: any): any {
  return (
    coupon?.stores?.find((item: any) => item?.logo?.url) ??
    (coupon?.logoStore?.logo?.url ? coupon.logoStore : null) ??
    coupon?.brands?.find((item: any) => item?.logo?.url) ??
    coupon?.banks?.find((item: any) => item?.logo?.url) ??
    coupon?.categories?.find((item: any) => item?.icon?.url) ??
    null
  );
}

function isActionableCoupon(coupon: any, now: Date): boolean {
  const identity = couponIdentity(coupon);
  return (
    isLiveOffer(coupon, now) &&
    typeof coupon?.title === 'string' &&
    coupon.title.trim().length > 0 &&
    hasSafeAffiliateLink(coupon?.affiliateLink) &&
    Boolean(identity?.name) &&
    Boolean(identity?.logo?.url ?? identity?.icon?.url)
  );
}

function dedupe<T extends { documentId?: string | null }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item?.documentId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function recentCoupons(
  strapi: Core.Strapi,
  ctx: any,
  filters: Record<string, unknown>,
): Promise<any[]> {
  const rows = await strapi.documents('api::coupon.coupon').findMany({
    filters: { ...PUBLISHED_OFFER_FILTER, ...filters },
    fields: COUPON_FIELDS as any,
    populate: couponRef.populate as any,
    sort: NEWEST_FIRST as any,
    limit: BACKFILL_QUERY_LIMIT,
  } as any);
  return await sanitizeOutput(strapi, ctx, 'api::coupon.coupon', rows);
}

async function recentDeals(
  strapi: Core.Strapi,
  ctx: any,
  filters: Record<string, unknown>,
): Promise<any[]> {
  const rows = await strapi.documents('api::deal.deal').findMany({
    filters: { ...PUBLISHED_OFFER_FILTER, ...filters },
    fields: dealRef.fields,
    populate: dealRef.populate,
    sort: NEWEST_FIRST as any,
    limit: BACKFILL_QUERY_LIMIT,
  } as any);
  return await sanitizeOutput(strapi, ctx, 'api::deal.deal', rows);
}

export async function fillAllCouponHolder(
  strapi: Core.Strapi,
  ctx: any,
  holder: any,
  limit: number,
  now: Date,
) {
  if (!holder) return;
  const selected = Array.isArray(holder.offers) ? holder.offers : [];
  if (selected.length > 0) {
    holder.offers = cap(
      dedupe(selected.filter((coupon: any) => isActionableCoupon(coupon, now))),
      limit,
    );
    return;
  }

  holder.offers = await latestActionableCatalog(strapi, ctx, {
    uid: 'api::coupon.coupon',
    fields: COUPON_FIELDS,
    populate: couponRef.populate,
    limit,
    now,
    accept: isActionableCoupon,
  });
}

export async function fillAllDealHolder(
  strapi: Core.Strapi,
  ctx: any,
  holder: any,
  limit: number,
  now: Date,
) {
  if (!holder) return;
  const selected = Array.isArray(holder.deals) ? holder.deals : [];
  if (selected.length > 0) {
    holder.deals = cap(
      dedupe(
        selected.filter((deal: any) => isActionableProductDeal(deal, now)),
      ),
      limit,
    );
    return;
  }

  holder.deals = await latestActionableCatalog(strapi, ctx, {
    uid: 'api::deal.deal',
    fields: dealRef.fields,
    populate: dealRef.populate,
    limit,
    now,
    accept: isActionableProductDeal,
  });
}

async function fillCouponHolder(
  strapi: Core.Strapi,
  ctx: any,
  holder: any,
  filters: Record<string, unknown>,
  limit: number,
  now: Date,
) {
  if (!holder) return;
  const curated = dedupe(
    (holder.offers ?? []).filter((coupon: any) => isActionableCoupon(coupon, now)),
  );
  const fallback = await recentCoupons(strapi, ctx, filters);
  holder.offers = cap(
    dedupe([
      ...curated,
      ...fallback.filter((coupon) => isActionableCoupon(coupon, now)),
    ]),
    limit,
  );
}

async function fillDealHolder(
  strapi: Core.Strapi,
  ctx: any,
  holder: any,
  filters: Record<string, unknown>,
  limit: number,
  now: Date,
) {
  if (!holder) return;
  const curated = dedupe(
    (holder.deals ?? []).filter((deal: any) => isActionableProductDeal(deal, now)),
  );
  const fallback = await recentDeals(strapi, ctx, filters);
  holder.deals = cap(
    dedupe([
      ...curated,
      ...fallback.filter((deal) => isActionableProductDeal(deal, now)),
    ]),
    limit,
  );
}

export async function fillSections(strapi: Core.Strapi, ctx: any, page: any) {
  const now = new Date();
  if (page.topPicks) {
    page.topPicks.offers = cap(
      dedupe(
        (page.topPicks.offers ?? []).filter((coupon: any) =>
          isActionableCoupon(coupon, now),
        ),
      ),
      INDEPENDENCE_DAY_SALE_CAPS.topPicks,
    );
  }

  const jobs: Promise<unknown>[] = [];
  if (sectionActive(page.couponsByCategory)) {
    page.couponsByCategory.tabs = (page.couponsByCategory?.tabs ?? []).slice(
      0,
      INDEPENDENCE_DAY_SALE_CAPS.categoryTabs,
    );
    for (const tab of page.couponsByCategory.tabs) {
      if (!tab?.category?.documentId) continue;
      jobs.push(
        fillCouponHolder(
          strapi,
          ctx,
          tab,
          { categories: { documentId: tab.category.documentId } },
          INDEPENDENCE_DAY_SALE_CAPS.perTab,
          now,
        ),
      );
    }
  }
  if (sectionActive(page.productDealsByCategory)) {
    for (const tab of page.productDealsByCategory?.tabs ?? []) {
      if (!tab?.category?.documentId) continue;
      jobs.push(
        fillDealHolder(
          strapi,
          ctx,
          tab,
          { categories: { documentId: tab.category.documentId } },
          INDEPENDENCE_DAY_SALE_CAPS.perTab,
          now,
        ),
      );
    }
  }
  if (sectionActive(page.couponsByStore)) {
    for (const tab of page.couponsByStore?.tabs ?? []) {
      if (!tab?.store?.documentId) continue;
      jobs.push(
        fillCouponHolder(
          strapi,
          ctx,
          tab,
          { stores: { documentId: tab.store.documentId } },
          INDEPENDENCE_DAY_SALE_CAPS.perTab,
          now,
        ),
      );
    }
  }

  if (sectionActive(page.allCoupons)) {
    jobs.push(
      fillAllCouponHolder(
        strapi,
        ctx,
        page.allCoupons,
        INDEPENDENCE_DAY_SALE_CAPS.allCoupons,
        now,
      ),
    );
  }
  if (sectionActive(page.allDeals)) {
    jobs.push(
      fillAllDealHolder(
        strapi,
        ctx,
        page.allDeals,
        INDEPENDENCE_DAY_SALE_CAPS.allDeals,
        now,
      ),
    );
  }
  await Promise.all(jobs);

  if (page.couponsByCategory) {
    page.couponsByCategory.tabs = (page.couponsByCategory.tabs ?? []).filter(
      (tab: any) => tab?.category && tab.offers?.length,
    );
  }
  if (page.productDealsByCategory) {
    page.productDealsByCategory.tabs = (
      page.productDealsByCategory.tabs ?? []
    ).filter((tab: any) => tab?.category && tab.deals?.length);
  }
  if (page.couponsByStore) {
    page.couponsByStore.tabs = (page.couponsByStore.tabs ?? []).filter(
      (tab: any) => tab?.store && tab.offers?.length,
    );
  }
}
