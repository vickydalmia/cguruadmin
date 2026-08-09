import type { Core } from '@strapi/strapi';
import {
  INDEPENDENCE_DAY_SALE_CAPS,
  INDEPENDENCE_DAY_SALE_UID,
} from '../../../constants/independence-day-sale-sections';
import { arrayizeOfferText } from '../../../utils/offer-text';
import { attachFestiveOffers } from '../../../utils/festive-offer-response';
import {
  BACKFILL_QUERY_LIMIT,
  NEWEST_FIRST,
  PUBLISHED_OFFER_FILTER,
  brandRef,
  cap,
  categoryRef,
  dealRef,
  hasSafeAffiliateLink,
  isActionableProductDeal,
  isLiveOffer,
  latestActionableCatalog,
  sanitizeOutput,
  storeRef,
} from '../../../utils/offer-visibility';

export const COUPON_FIELDS = [
  'title',
  'content',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
  'badge',
  'code',
  'couponType',
  'affiliateLink',
  'checkoutMerchant',
  // Affiliate-brand offers render the BRAND logo in their identity slot.
  'isForAffiliateBrand',
  'expiresAt',
  'scheduledAt',
  'contentStatus',
  'publishedOn',
  'publishedAt',
  'updatedAt',
  'createdAt',
] as const;

const bankRef = {
  fields: ['name', 'slug', 'logoAlt'],
  populate: { logo: true },
};

const couponRef = {
  fields: COUPON_FIELDS,
  populate: {
    logoStore: storeRef,
    stores: storeRef,
    brands: brandRef,
    categories: categoryRef,
    banks: bankRef,
    uniqueCouponPool: { fields: ['name'] },
  },
};

const publishedCouponRef = {
  ...couponRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const publishedDealRef = {
  ...dealRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const PAGE_POPULATE = {
  countdown: true,
  hero: { populate: { image: true } },
  topPicks: {
    populate: { viewAllCta: true, offers: publishedCouponRef },
  },
  couponsByCategory: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          iconOverride: true,
          category: categoryRef,
          offers: publishedCouponRef,
        },
      },
    },
  },
  productDealsByCategory: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          category: categoryRef,
          deals: publishedDealRef,
        },
      },
    },
  },
  promoStrip: { populate: { cta: true } },
  couponsByStore: {
    populate: {
      tabs: {
        populate: {
          store: storeRef,
          offers: publishedCouponRef,
        },
      },
    },
  },
  allCoupons: {
    // Keep the unfiltered relation long enough to distinguish an editor-curated
    // list from an intentionally empty relation. Public output is filtered by
    // fillAllCouponHolder before the response is sent.
    populate: { viewAllCta: true, offers: couponRef },
  },
  allDeals: {
    populate: { viewAllCta: true, deals: dealRef },
  },
  popularSearches: {
    populate: {
      stores: { fields: ['name', 'slug'] },
      brands: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
      banks: { fields: ['name', 'slug'] },
    },
  },
  seo: { populate: { ogImage: true } },
} as const;

const sectionActive = (section: any) => section && section.enabled !== false;

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

async function fillSections(strapi: Core.Strapi, ctx: any, page: any) {
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async independenceDaySaleFull(ctx: any) {
    const page = await strapi
      .documents(INDEPENDENCE_DAY_SALE_UID as any)
      .findFirst({ populate: PAGE_POPULATE as any });

    if (!page) return ctx.notFound('Independence Day sale page not found');

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      INDEPENDENCE_DAY_SALE_UID,
      page,
    );
    await fillSections(strapi, ctx, sanitized);
    arrayizeOfferText(sanitized);
    await attachFestiveOffers(strapi, sanitized);

    return ctx.send({ data: sanitized });
  },
});
