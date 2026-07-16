import type { Core } from '@strapi/strapi';
import { DOTD_SECTION_CAPS as SECTION_CAPS } from '../../../constants/deal-of-the-day-sections';
import { arrayizeOfferText } from '../../../utils/offer-text';
import {
  backfillDeals,
  cap,
  categoryRef,
  dealRef,
  isLiveOffer,
  NEWEST_FIRST,
  PUBLISHED_OFFER_FILTER,
  sanitizeOutput,
  storeRef,
} from '../../../utils/offer-visibility';

// Aggregate endpoint for the deal-of-the-day category landing page: one
// request returns every curated section fully populated, mirroring the
// homepage-full contract. Deal-schema records only — Coupon records never
// enter any section on this page.

// Each API list keeps a CMS-authored buffer over what the site renders so a
// mid-cycle expiry/delete never leaves a visible hole. The same caps are also
// enforced on writes by validateDealOfTheDaySectionLimits.
const TOP_DEALS_RENDER_COUNT = 6;
const TAB_RENDER_COUNT = 6;
const SMART_STACK_BUFFER_TARGET = SECTION_CAPS.smartSavingStack;

const DEAL_FIELDS = dealRef.fields;

// Smart-stack cards only render when both benefit texts exist; enforce the
// same rule in queries so backfill never surfaces a card missing its strip.
const BENEFIT_TEXT_FILTER = {
  cashbackText: { $notNull: true, $ne: '' },
  bankOfferText: { $notNull: true, $ne: '' },
} as const;

// Gen-Z and Telegram cards render without an expandable details row, so keep
// their Deal payload free of unused rich text (heroDealRef precedent).
const compactDealRef = {
  ...dealRef,
  fields: DEAL_FIELDS.filter((field) => field !== 'content'),
};

// Telegram-exclusive deals are join-gated marketing: never ship the promo
// code to anonymous API consumers — the locked cards cannot reveal it anyway.
const telegramDealRef = {
  ...dealRef,
  fields: DEAL_FIELDS.filter((field) => field !== 'content' && field !== 'code'),
};

const publishedDealListRef = {
  ...dealRef,
  filters: PUBLISHED_OFFER_FILTER,
  sort: NEWEST_FIRST,
};

const publishedCompactDealListRef = {
  ...compactDealRef,
  filters: PUBLISHED_OFFER_FILTER,
  sort: NEWEST_FIRST,
};

const publishedTelegramDealListRef = {
  ...telegramDealRef,
  filters: PUBLISHED_OFFER_FILTER,
  sort: NEWEST_FIRST,
};

const dealListSection = { populate: { viewAllCta: true, deals: publishedDealListRef } };
const compactDealListSection = {
  populate: { viewAllCta: true, deals: publishedCompactDealListRef },
};

const DOTD_POPULATE = {
  seo: { populate: { ogImage: true } },
  topPicks: dealListSection,
  topDeals: dealListSection,
  dealsByCategory: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          category: categoryRef,
          deals: publishedDealListRef,
        },
      },
    },
  },
  dealsByStore: {
    populate: {
      viewAllCta: true,
      tabs: {
        populate: {
          viewAllCta: true,
          store: storeRef,
          deals: publishedDealListRef,
        },
      },
    },
  },
  smartSavingStack: dealListSection,
  trendingNow: dealListSection,
  genZDrops: compactDealListSection,
  // No viewAllCta populate: deal-day.telegram-deals has no such field.
  telegramDeals: { populate: { deals: publishedTelegramDealListRef } },
  allDeals: { populate: { viewAllCta: true } },
} as const;

const DEAL_LIST_SECTIONS = [
  'topPicks',
  'topDeals',
  'smartSavingStack',
  'trendingNow',
  'genZDrops',
  'telegramDeals',
] as const;

const hasBenefitTexts = (deal: any) =>
  typeof deal?.cashbackText === 'string' &&
  deal.cashbackText.trim().length > 0 &&
  typeof deal?.bankOfferText === 'string' &&
  deal.bankOfferText.trim().length > 0;

// The site treats only an explicit `enabled: false` as a disable (legacy
// entries saved without the flag still render) — gate backfill the same way
// so a rendered section is never left starved of its fallback deals.
const sectionActive = (section: any) => section && section.enabled !== false;

// Curated relations bypass the contentStatus visibility filter used by the
// list endpoints — strip anything that isn't live before the payload leaves
// the API, and drop tabs whose entity relation resolved to null (deleted).
function dropDeadOffers(page: any) {
  if (!page) return page;
  const now = new Date();
  const live = (deal: any) => isLiveOffer(deal, now);

  for (const key of DEAL_LIST_SECTIONS) {
    const section = page[key];
    if (section?.deals) {
      section.deals = section.deals.filter(live);
    }
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
  return page;
}

function capCuratedLists(page: any) {
  if (!page) return page;

  for (const key of DEAL_LIST_SECTIONS) {
    const section = page[key];
    if (section?.deals) {
      section.deals = cap(section.deals, SECTION_CAPS[key]);
    }
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
  return page;
}

async function fillDerivedSections(strapi: Core.Strapi, ctx: any, page: any) {
  const now = new Date();

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
        .map((tab: any) =>
          backfillDeals(strapi, ctx, tab, {
            filters: { categories: { documentId: tab.category.documentId } },
            renderCount: TAB_RENDER_COUNT,
            capLimit: SECTION_CAPS.perCategoryTab,
            now,
          }),
        ),
    );
  }

  if (sectionActive(page?.dealsByStore) && Array.isArray(page.dealsByStore.tabs)) {
    await Promise.all(
      page.dealsByStore.tabs
        .filter((tab: any) => tab?.store?.documentId)
        .map((tab: any) =>
          backfillDeals(strapi, ctx, tab, {
            filters: {
              $or: [
                { stores: { documentId: tab.store.documentId } },
                { primaryStore: { documentId: tab.store.documentId } },
              ],
            },
            renderCount: TAB_RENDER_COUNT,
            capLimit: SECTION_CAPS.perStoreTab,
            now,
          }),
        ),
    );
  }

  if (sectionActive(page?.smartSavingStack)) {
    await backfillDeals(strapi, ctx, page.smartSavingStack, {
      filters: BENEFIT_TEXT_FILTER,
      renderCount: SMART_STACK_BUFFER_TARGET,
      capLimit: SECTION_CAPS.smartSavingStack,
      now,
      accept: hasBenefitTexts,
    });
  }

  return page;
}

const countDeals = (strapi: Core.Strapi, filters: Record<string, unknown>) =>
  strapi.documents('api::deal.deal').count({
    filters: { ...PUBLISHED_OFFER_FILTER, ...filters },
  } as any);

// Attach computed deal counts (never stored, so m2m edits and cron status
// flips can never drift) — these feed the per-section "N Offers" links.
// Disabled sections are skipped: the site never renders their counts.
async function attachDealCounts(strapi: Core.Strapi, page: any) {
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
          $or: [{ stores: { documentId } }, { primaryStore: { documentId } }],
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async dealOfTheDayFull(ctx) {
    // The single type has draftAndPublish disabled — the entry is live once
    // saved; findFirst returns null until an admin creates it.
    const page = await strapi
      .documents('api::deal-of-the-day-page.deal-of-the-day-page')
      .findFirst({ populate: DOTD_POPULATE as any });

    if (!page) {
      return ctx.notFound('Deal of the day page not found');
    }

    const sanitized = await sanitizeOutput(
      strapi,
      ctx,
      'api::deal-of-the-day-page.deal-of-the-day-page',
      page,
    );
    dropDeadOffers(sanitized);
    await fillDerivedSections(strapi, ctx, sanitized);
    capCuratedLists(sanitized);
    await attachDealCounts(strapi, sanitized);
    // Nested deal cards: emit offerText as an array of words.
    arrayizeOfferText(sanitized);

    return ctx.send({ data: sanitized });
  },
});
