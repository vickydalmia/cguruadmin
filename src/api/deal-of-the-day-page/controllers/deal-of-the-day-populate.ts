// Deal of the Day POPULATE/QUERY DEFINITIONS: the section populate trees,
// render counts and the deal-list section tables. Split out of ./custom.ts,
// which keeps the load -> sanitize -> transform -> send flow.
import {
  categoryRef,
  dealRef,
  PUBLISHED_OFFER_FILTER,
  storeRef,
} from '../../../utils/offer-visibility';

// Fixed-size API lists keep CMS-authored buffers over what the site renders.
// Smart Saving Stack is the exception: every curated Deal is returned in the
// editor's order for its unlimited carousel.
export const TOP_DEALS_RENDER_COUNT = 6;

export const TAB_RENDER_COUNT = 6;

export const DEAL_FIELDS = dealRef.fields;

// Smart-stack cards require both benefit texts. Code availability is not an
// eligibility rule: a Deal with no public code still belongs in the stack.
// Keep this identical to hasSmartStackBenefits in the frontend so the API
// count and rendered list cannot disagree.
export const BENEFIT_TEXT_FILTER = {
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

// These filters hide unavailable Deals without adding `sort`: a nested sort
// would override the relation order editors set by drag-and-drop. Newest-first
// applies only to the separate fallback query in backfillDeals.
export const publishedDealListRef = {
  ...dealRef,
  filters: PUBLISHED_OFFER_FILTER,
};

export const publishedCompactDealListRef = {
  ...compactDealRef,
  filters: PUBLISHED_OFFER_FILTER,
};

export const publishedTelegramDealListRef = {
  ...telegramDealRef,
  filters: PUBLISHED_OFFER_FILTER,
};

const dealListSection = { populate: { viewAllCta: true, deals: publishedDealListRef } };

const compactDealListSection = {
  populate: { viewAllCta: true, deals: publishedCompactDealListRef },
};

const orderedDealListSection = {
  populate: { viewAllCta: true, deals: dealRef },
};

export const DOTD_POPULATE = {
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
          // Do not filter or sort here: relation presence selects curated-only
          // mode, even when every selected Deal later proves unavailable, and
          // the editor's chosen order must remain authoritative.
          deals: dealRef,
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
          // Relation presence selects curated-only mode. Preserve the editor's
          // order and filter unavailable Deals after that choice is captured.
          deals: dealRef,
        },
      },
    },
  },
  // Do not filter or sort the nested relation: either can destroy Strapi's
  // authored relation ordering. Visibility and benefit rules run afterward.
  smartSavingStack: orderedDealListSection,
  trendingNow: dealListSection,
  genZDrops: compactDealListSection,
  // No viewAllCta populate: deal-day.telegram-deals has no such field. Items
  // wrap each Deal so editors can override the unlock destination for THIS
  // section only (linkOverride) without touching the Deal's affiliateLink,
  // which every other rail still uses. Component scalars need no populate.
  telegramDeals: {
    populate: { items: { populate: { deal: publishedTelegramDealListRef } } },
  },
  allDeals: { populate: { viewAllCta: true, deals: dealRef } },
} as const;

// Sections shaped as `{ deals: Deal[] }`. telegramDeals is deliberately absent:
// it carries `items: [{ deal, linkOverride, titleOverride }]` instead, and is
// filtered and capped explicitly below.
export const DEAL_LIST_SECTIONS = [
  'topPicks',
  'topDeals',
  'smartSavingStack',
  'trendingNow',
  'genZDrops',
] as const;

export const CAPPED_DEAL_LIST_SECTIONS = [
  'topPicks',
  'topDeals',
  'trendingNow',
  'genZDrops',
] as const;
