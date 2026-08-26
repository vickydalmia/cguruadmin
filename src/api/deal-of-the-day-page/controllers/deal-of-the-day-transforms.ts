// Deal of the Day SECTION TRANSFORMS: dead-offer cleanup, curated caps,
// derived-section fills and per-section deal counts. Split out of
// ./custom.ts, which keeps the load -> sanitize -> transform -> send flow.
import type { Core } from '@strapi/strapi';
import { DOTD_SECTION_CAPS as SECTION_CAPS } from '../../../constants/deal-of-the-day-sections';
import {
  backfillDeals,
  cap,
  dealRef,
  isActionableProductDeal,
  isLiveOffer,
  latestActionableCatalog,
  PUBLISHED_OFFER_FILTER,
} from '../../../utils/offer-visibility';
import {
  BENEFIT_TEXT_FILTER,
  CAPPED_DEAL_LIST_SECTIONS,
  DEAL_FIELDS,
  DEAL_LIST_SECTIONS,
  TAB_RENDER_COUNT,
  TOP_DEALS_RENDER_COUNT,
  publishedCompactDealListRef,
  publishedDealListRef,
  publishedTelegramDealListRef,
} from './deal-of-the-day-populate';

export const hasSmartStackFields = (deal: any) =>
  typeof deal?.cashbackText === 'string' &&
  deal.cashbackText.trim().length > 0 &&
  typeof deal?.bankOfferText === 'string' &&
  deal.bankOfferText.trim().length > 0;

// The site treats only an explicit `enabled: false` as a disable (legacy
// entries saved without the flag still render) — gate backfill the same way
// so a rendered section is never left starved of its fallback deals.
export const sectionActive = (section: any) => section && section.enabled !== false;

// Curated relations bypass the contentStatus visibility filter used by the
// list endpoints — strip anything that isn't live before the payload leaves
// the API, and drop tabs whose entity relation resolved to null (deleted).
export function dropDeadOffers(page: any) {
  if (!page) return page;
  const now = new Date();
  const live = (deal: any) => isLiveOffer(deal, now);

  for (const key of DEAL_LIST_SECTIONS) {
    const section = page[key];
    if (section?.deals) {
      section.deals = section.deals.filter(live);
      if (key === 'smartSavingStack') {
        section.deals = section.deals.filter(hasSmartStackFields);
      }
    }
  }
  // Telegram items are wrappers: drop the whole item when its Deal is missing
  // (deleted or filtered out as unpublished) or no longer live, so an item can
  // never render as a card without a Deal behind it.
  if (page.telegramDeals?.items) {
    page.telegramDeals.items = page.telegramDeals.items.filter(
      (item: any) => item?.deal && live(item.deal),
    );
  }
  if (page.dealsByCategory?.tabs) {
    page.dealsByCategory.tabs = page.dealsByCategory.tabs.filter(
      (tab: any) => tab?.category,
    );
    for (const tab of page.dealsByCategory.tabs) {
      if (tab?.deals) tab.deals = tab.deals.filter(live);
    }
  }
  if (page.dealsByStore?.tabs) {
    page.dealsByStore.tabs = page.dealsByStore.tabs.filter((tab: any) => tab?.store);
    for (const tab of page.dealsByStore.tabs) {
      if (tab?.deals) tab.deals = tab.deals.filter(live);
    }
  }
  if (page.allDeals?.deals) {
    page.allDeals.deals = page.allDeals.deals.filter(live);
  }
  return page;
}

export function capCuratedLists(page: any) {
  if (!page) return page;

  for (const key of CAPPED_DEAL_LIST_SECTIONS) {
    const section = page[key];
    if (section?.deals) {
      section.deals = cap(section.deals, SECTION_CAPS[key]);
    }
  }
  if (page.telegramDeals?.items) {
    page.telegramDeals.items = cap(
      page.telegramDeals.items,
      SECTION_CAPS.telegramDeals,
    );
  }
  if (page.dealsByCategory?.tabs) {
    for (const tab of page.dealsByCategory.tabs) {
      if (tab?.deals) tab.deals = cap(tab.deals, SECTION_CAPS.perCategoryTab);
    }
  }
  if (page.dealsByStore?.tabs) {
    for (const tab of page.dealsByStore.tabs) {
      if (tab?.deals) tab.deals = cap(tab.deals, SECTION_CAPS.perStoreTab);
    }
  }
  if (page.allDeals?.deals) {
    page.allDeals.deals = cap(page.allDeals.deals, SECTION_CAPS.allDeals);
  }
  return page;
}

export async function fillDerivedSections(
  strapi: Core.Strapi,
  ctx: any,
  page: any,
  curatedSelections: {
    categoryTabs: ReadonlySet<any>;
    storeTabs: ReadonlySet<any>;
    allDeals: boolean;
  },
) {
  const now = new Date();

  // All Deals mirrors the Independence Day policy: selected Deals are
  // authoritative and retain editor order; a genuinely empty relation gets
  // the latest actionable Deals sitewide ordered by Published date.
  if (sectionActive(page?.allDeals)) {
    page.allDeals.source = curatedSelections.allDeals ? 'curated' : 'catalog';
    page.allDeals.deals = curatedSelections.allDeals
      ? (page.allDeals.deals ?? []).filter((deal: any) =>
          isActionableProductDeal(deal, now),
        )
      : await latestActionableCatalog(strapi, ctx, {
          uid: 'api::deal.deal',
          fields: dealRef.fields,
          populate: dealRef.populate,
          limit: SECTION_CAPS.allDeals,
          now,
          accept: isActionableProductDeal,
        });
  }

  if (sectionActive(page?.topDeals)) {
    await backfillDeals(strapi, ctx, page.topDeals, {
      filters: {},
      renderCount: TOP_DEALS_RENDER_COUNT,
      capLimit: SECTION_CAPS.topDeals,
      now,
    });
  }

  // Tabs are independent holders — backfill them concurrently so a cache
  // miss costs one query round-trip per section, not one per tab.
  if (sectionActive(page?.dealsByCategory) && Array.isArray(page.dealsByCategory.tabs)) {
    await Promise.all(
      page.dealsByCategory.tabs
        .filter((tab: any) => tab?.category?.documentId)
        .map((tab: any) => {
          // Category tabs have two exclusive modes. Any explicit CMS
          // selection is authoritative and never mixes with category-query
          // results. Only a genuinely empty relation activates fallback.
          if (curatedSelections.categoryTabs.has(tab)) {
            tab.deals = (tab.deals ?? []).filter((deal: any) =>
              isActionableProductDeal(deal, now),
            );
            return Promise.resolve();
          }

          return backfillDeals(strapi, ctx, tab, {
            filters: { categories: { documentId: tab.category.documentId } },
            renderCount: TAB_RENDER_COUNT,
            capLimit: SECTION_CAPS.perCategoryTab,
            now,
          });
        }),
    );
  }

  if (sectionActive(page?.dealsByStore) && Array.isArray(page.dealsByStore.tabs)) {
    await Promise.all(
      page.dealsByStore.tabs
        .filter((tab: any) => tab?.store?.documentId)
        .map((tab: any) => {
          if (curatedSelections.storeTabs.has(tab)) {
            tab.deals = (tab.deals ?? []).filter((deal: any) =>
              isActionableProductDeal(deal, now),
            );
            return Promise.resolve();
          }

          return backfillDeals(strapi, ctx, tab, {
            filters: {
              stores: { documentId: tab.store.documentId },
            },
            renderCount: TAB_RENDER_COUNT,
            capLimit: SECTION_CAPS.perStoreTab,
            now,
          });
        }),
    );
  }

  return page;
}

export const countDeals = (strapi: Core.Strapi, filters: Record<string, unknown>) =>
  strapi.documents('api::deal.deal').count({
    filters: { ...PUBLISHED_OFFER_FILTER, ...filters },
  } as any);

// Attach computed deal counts (never stored, so m2m edits and cron status
// flips can never drift) — these feed the per-section "N Offers" links.
// Disabled sections are skipped: the site never renders their counts.
export async function attachDealCounts(strapi: Core.Strapi, page: any) {
  if (!page) return page;

  const jobs: Promise<void>[] = [];

  if (sectionActive(page.dealsByCategory) && page.dealsByCategory.tabs) {
    for (const tab of page.dealsByCategory.tabs) {
      const documentId = tab?.category?.documentId;
      if (!documentId) continue;
      jobs.push(
        countDeals(strapi, { categories: { documentId } }).then((count) => {
          tab.dealCount = count;
        }),
      );
    }
  }
  if (sectionActive(page.dealsByStore) && page.dealsByStore.tabs) {
    for (const tab of page.dealsByStore.tabs) {
      const documentId = tab?.store?.documentId;
      if (!documentId) continue;
      jobs.push(
        countDeals(strapi, {
          stores: { documentId },
        }).then((count) => {
          tab.dealCount = count;
        }),
      );
    }
  }
  if (sectionActive(page.smartSavingStack)) {
    jobs.push(
      countDeals(strapi, BENEFIT_TEXT_FILTER).then((count) => {
        page.smartSavingStack.totalCount = count;
      }),
    );
  }
  jobs.push(
    countDeals(strapi, {}).then((count) => {
      page.totalDealCount = count;
    }),
  );

  await Promise.all(jobs);
  return page;
}
