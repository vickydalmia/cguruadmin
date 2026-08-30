// Homepage SECTION TRANSFORMS: dead-offer cleanup, curated caps, top-deal
// fallback filling, offer counts, notifications and route metadata. Split
// out of ./custom.ts, which keeps the load -> sanitize -> transform -> send
// flow.
import type { Core } from '@strapi/strapi';
import {
  backfillDeals,
  cap,
  isLiveOffer,
  PUBLISHED_OFFER_FILTER,
} from '../../../utils/offer-visibility';
import {
  MAX_LIST_ITEMS,
  MAX_TOP_STORES,
  SECTION_LIST_CAPS,
  TOP_DEALS_RENDER_COUNT,
  publishedDealListRef,
} from './homepage-populate';
import { homepageHeroOfferTarget } from '../../../utils/homepage-hero-offer';

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstCouponEntityImage(coupon: any): any {
  const candidates = [
    ...(coupon?.stores ?? []).map((item: any) => item?.logo),
    coupon?.logoStore?.logo,
    ...(coupon?.brands ?? []).map((item: any) => item?.logo),
    ...(coupon?.banks ?? []).map((item: any) => item?.logo),
    ...(coupon?.categories ?? []).map((item: any) => item?.icon),
  ];
  return candidates.find((media: any) => nonBlank(media?.url)) ?? null;
}

function notificationItem(
  kind: 'coupon' | 'deal',
  config: any,
  now: Date,
) {
  const target = kind === 'coupon' ? config?.coupon : config?.productDeal;
  if (!isLiveOffer(target, now)) return null;

  const targetId = Number(target?.id);
  const title =
    nonBlank(config?.titleOverride) ?? nonBlank(target?.title);
  const image =
    config?.imageOverride?.url
      ? config.imageOverride
      : kind === 'coupon'
        ? firstCouponEntityImage(target)
        : target?.dealImage;

  if (
    !Number.isSafeInteger(targetId) ||
    targetId <= 0 ||
    !title ||
    !nonBlank(image?.url)
  ) {
    return null;
  }

  return { kind, targetId, title, image };
}

function notificationRows(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

export function headerNotificationPayload(menu: any, now = new Date()) {
  return [
    ...notificationRows(menu?.notification?.coupon).map((config) =>
      notificationItem('coupon', config, now),
    ),
    ...notificationRows(menu?.notification?.productDeal).map((config) =>
      notificationItem('deal', config, now),
    ),
  ].filter(Boolean);
}

// Homepage components reference coupons/deals directly, which bypasses the
// contentStatus visibility filter used by the list endpoints — strip anything
// that isn't live before the payload leaves the API. Card-wrapper items
// (hero/topOffers/cgExclusive/newlyAdded) carry their own copied image and
// override text, so an item whose relation resolved to null (deleted, or
// filtered out by the populate as expired/scheduled) must be dropped too —
// otherwise the card renders with a dead offer behind it.
export function dropDeadOffers(homepage: any) {
  if (!homepage) return homepage;
  const now = new Date();
  const live = (offer: any) => isLiveOffer(offer, now);

  if (homepage.hero?.products) {
    homepage.hero.products = homepage.hero.products.filter((item: any) =>
      live(homepageHeroOfferTarget(item)),
    );
  }
  for (const key of ['topOffers', 'cgExclusive', 'newlyAdded']) {
    const section = homepage[key];
    if (section?.items) {
      section.items = section.items.filter((i: any) => live(i.coupon));
    }
  }
  if (homepage.bankOffers?.items) {
    homepage.bankOffers.items = homepage.bankOffers.items.filter((i: any) => i.bank);
  }
  if (homepage.offersByBrand?.offers) {
    homepage.offersByBrand.offers = homepage.offersByBrand.offers.filter(live);
  }
  if (homepage.exploreOffers?.tabs) {
    for (const tab of homepage.exploreOffers.tabs) {
      if (tab?.offers) {
        tab.offers = tab.offers.filter(live);
      }
    }
  }
  if (homepage.topDeals?.deals) {
    homepage.topDeals.deals = homepage.topDeals.deals.filter(live);
  }
  return homepage;
}

// The curated store/deal lists are unbounded oneToMany relations (schema
// `max` only exists for repeatable components), so cap them here — per
// section — to keep the payload and the per-store count queries bounded no
// matter what an admin attaches in the CMS. Runs after dropDeadOffers, so
// the caps count only live offers.
export function capCuratedLists(homepage: any) {
  if (!homepage) return homepage;

  if (homepage.popularStores?.stores) {
    homepage.popularStores.stores = cap(
      homepage.popularStores.stores,
      SECTION_LIST_CAPS.popularStores,
    );
  }
  if (homepage.topDeals?.deals) {
    homepage.topDeals.deals = cap(
      homepage.topDeals.deals,
      SECTION_LIST_CAPS.topDeals,
    );
  }
  if (homepage.offersByBrand?.offers) {
    homepage.offersByBrand.offers = cap(
      homepage.offersByBrand.offers,
      SECTION_LIST_CAPS.offersByBrand,
    );
  }
  if (homepage.exploreOffers?.tabs) {
    for (const tab of homepage.exploreOffers.tabs) {
      if (tab?.offers) {
        tab.offers = cap(tab.offers, SECTION_LIST_CAPS.exploreOffersPerTab);
      }
    }
  }
  return homepage;
}

// Legacy imports can violate today's required Deal fields. Keep every valid
// curated Top Deal in editor order, then fill the remaining visible slots
// from recent Deal-schema records. Coupon records never enter this section.
// The site treats only an explicit `enabled: false` as a disable (legacy
// entries saved without the flag still render) — gate backfill the same way.
export async function fillTopDeals(
  strapi: Core.Strapi,
  ctx: any,
  homepage: any,
) {
  const section = homepage?.topDeals;
  if (!section || section.enabled === false) return homepage;

  await backfillDeals(strapi, ctx, section, {
    filters: {},
    renderCount: TOP_DEALS_RENDER_COUNT,
    capLimit: SECTION_LIST_CAPS.topDeals,
    now: new Date(),
  });

  return homepage;
}

async function countOffersForStore(strapi: Core.Strapi, documentId: string) {
  const filters = {
    stores: { documentId },
    contentStatus: { $eq: 'published' },
  } as any;
  const [coupons, deals] = await Promise.all([
    strapi.documents('api::coupon.coupon').count({ filters }),
    strapi.documents('api::deal.deal').count({ filters }),
  ]);
  return coupons + deals;
}

// Attach a computed offerCount to every store in the popularStores section.
// Computed (not stored) so m2m edits and cron status flips can never drift.
export async function attachOfferCounts(strapi: Core.Strapi, homepage: any) {
  const section = homepage?.popularStores;
  if (!section) return homepage;

  const stores = [section.featuredStore, ...(section.stores ?? [])].filter(Boolean);
  const uniqueIds = [...new Set(stores.map((s: any) => s.documentId))] as string[];
  // Two counts per store, so an unbounded Promise.all here scales the burst
  // with the section cap (31 + featured = 64 statements). The pool is 5-10
  // connections shared with the admin, cron, redeem and outbox paths, so a
  // single homepage cache miss could otherwise starve them. Batching keeps
  // the burst flat as the cap grows; results and order are unchanged.
  const counts: (readonly [string, number])[] = [];
  const BATCH = 4; // 4 stores in flight = 8 concurrent count statements
  for (let index = 0; index < uniqueIds.length; index += BATCH) {
    counts.push(
      ...(await Promise.all(
        uniqueIds
          .slice(index, index + BATCH)
          .map(async (id) => [id, await countOffersForStore(strapi, id)] as const),
      )),
    );
  }
  const byId = new Map(counts);
  for (const store of stores) {
    store.offerCount = byId.get(store.documentId) ?? 0;
  }
  return homepage;
}

export function routeMetadata(path: string, row: any) {
  const updatedAt =
    row?.updatedAt instanceof Date
      ? row.updatedAt.toISOString()
      : typeof row?.updatedAt === 'string'
        ? row.updatedAt
        : undefined;
  return {
    path,
    ...(updatedAt ? { updatedAt } : {}),
    noIndex: row?.seo?.noIndex === true,
  };
}
