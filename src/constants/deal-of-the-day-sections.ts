// Editor-facing labels and help text for the Deal of the Day Page single type,
// numbered in LIVE page render order (cguru-ui features/deal-of-the-day/
// deal-of-the-day-page.astro). Pinned into the content-manager view config by
// the server bootstrap (src/index.ts) — same config-as-code approach as
// homepage-sections.ts; keep it dependency-free.
import type { SectionLabel } from './homepage-sections';

export const DOTD_UID = 'api::deal-of-the-day-page.deal-of-the-day-page';

// CMS buffer limits. The frontend deliberately renders half of each list so
// expired/deleted Deals can fall away without leaving visible holes.
export const DOTD_SECTION_CAPS = {
  topPicks: 4, // UI renders 2
  topDeals: 10, // UI renders 6
  perCategoryTab: 10, // UI renders up to 6 per tab
  perStoreTab: 10, // UI renders up to 6 per tab
  smartSavingStack: 6, // UI renders 3
  trendingNow: 10, // UI renders up to 6
  genZDrops: 6, // UI renders 3
  telegramDeals: 6, // UI renders 3
  allDeals: 24, // UI shows 9 initially, remainder behind load-more
} as const;

export const DOTD_SECTION_LABELS: SectionLabel[] = [
  {
    attr: 'title',
    label: 'Admin title',
    description: 'Internal name shown in the admin only — never appears on the site.',
  },
  {
    attr: 'heroTitle',
    label: '1 · Hero title',
    description:
      'Big heading at the top of the page. Leave empty to use the default ' +
      '("Unlock Extra Savings on Every Order" with the accent styling).',
  },
  {
    attr: 'heroSubtitle',
    label: '1 · Hero subtitle',
    description:
      'Line under the hero title. Leave empty to use the default ' +
      '("Unbeatable Offers Handpicked for You").',
  },
  {
    attr: 'topPicks',
    label: '1 · Hero — Top Picks',
    description:
      'Hand-picked Deal cards beside the hero text. Add up to 4; the site shows 2 and ' +
      'keeps the other 2 buffered in case a Deal expires or is removed. ' +
      'This section does NOT auto-fill — empty means no cards.',
  },
  {
    attr: 'topDeals',
    label: '2 · Top Deals For Today',
    description:
      'Product Deal cards. The site shows 6 (up to 10 buffered); empty slots ' +
      'auto-fill with the newest published deals.',
  },
  {
    attr: 'dealsByCategory',
    label: '3 · Deals by Category',
    description:
      'Tabbed Deal grid (up to 8 category tabs). If a tab has selected Deals, only ' +
      'those Deals are used in the selected order. If no Deals are selected, the tab ' +
      'auto-fills with the newest Deals from that category. The two modes never merge; ' +
      'the site shows up to 6 selected or fallback Deals (maximum 10 configured).',
  },
  {
    attr: 'dealsByStore',
    label: '4 · Deals by Store',
    description:
      'Tabbed Deal grid (up to 8 store tabs). If a tab has selected Deals, only ' +
      'those Deals are used in the selected order. If no Deals are selected, the tab ' +
      'auto-fills with the newest Deals from that store. The two modes never merge; ' +
      'the site shows up to 6 selected or fallback Deals (maximum 10 configured).',
  },
  {
    attr: 'smartSavingStack',
    label: '5 · Smart Saving Stack',
    description:
      'Only deals with BOTH Cashback Text and Bank Offer Text filled appear here — ' +
      'deals missing either text are dropped from the page. Remaining slots auto-fill ' +
      'from recent deals that carry both texts. Add up to 6; the site shows 3 and keeps ' +
      'the other 3 buffered in case a Deal expires or is removed.',
  },
  {
    attr: 'trendingNow',
    label: '6 · Trending Now',
    description:
      'Hand-picked Deal cards. The site shows up to 6 (10 buffered); ' +
      'this section does NOT auto-fill — empty means no section.',
  },
  {
    attr: 'genZDrops',
    label: '7 · Gen-Z Drops',
    description:
      'Hand-picked compact Deal cards (no expandable details). Add up to 6; the site ' +
      'shows 3 and keeps the other 3 buffered. This section does NOT auto-fill.',
  },
  {
    attr: 'telegramDeals',
    label: '8 · Telegram Exclusive',
    description:
      'Join-gated locked Deal cards. The site shows 3 (up to 6 buffered). ' +
      'Promo codes on these deals are never exposed through the public API.',
  },
  {
    attr: 'allDeals',
    label: '9 · All Deals',
    description:
      'If Deals are selected, the grid uses only those Deals in the selected order ' +
      '(maximum 24; the site shows 9 first with the rest behind load-more). If none ' +
      'are selected, it uses the newest Deals from the full catalog. The two modes ' +
      'never merge. Also controls the heading and "view all" link.',
  },
  {
    attr: 'seo',
    label: 'SEO (search & social)',
    description:
      'Meta title, description and share image for this page — not visible on the page itself.',
  },
];
