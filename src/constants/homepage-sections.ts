// Editor-facing labels and help text for the Homepage single type, numbered in
// LIVE page render order (cguru-ui features/home/home.astro) — note Popular
// Stores renders BEFORE Top Offers, unlike the schema order.
// Consumed by BOTH the server bootstrap (src/index.ts pins them into the
// content-manager view config) and the admin bundle (src/admin/app.tsx uses
// the labels in the validation-problems side panel) — keep it dependency-free.
export const HOMEPAGE_UID = 'api::homepage.homepage';

export type HomepageSectionLabel = {
  attr: string;
  label: string;
  description: string;
};

export const HOMEPAGE_SECTION_LABELS: HomepageSectionLabel[] = [
  {
    attr: 'title',
    label: 'Admin title',
    description: 'Internal name shown in the admin only — never appears on the site.',
  },
  {
    attr: 'hero',
    label: '1 · Hero — banner slider & products',
    description:
      'Top of the page: banner slider (desktop 1668×864, mobile 686×412) plus up to 4 product cards beside it.',
  },
  {
    attr: 'popularStores',
    label: '2 · Popular Stores',
    description: 'Store row directly under the hero: one featured store plus the popular stores list.',
  },
  {
    attr: 'topOffers',
    label: '3 · Top Offers',
    description: 'Coupon banner cards (584×356 images) shown after Popular Stores.',
  },
  {
    attr: 'topDeals',
    label: '4 · Top Deals',
    description:
      'Deal strip NEAR THE TOP of the page, right after Top Offers. Same layout as ' +
      '"8 · Deals by Brand" — that one is the strip lower down the page.',
  },
  {
    attr: 'cgExclusive',
    label: '5 · CG Exclusive',
    description: 'Exclusive coupon banners (768×370 images) after Top Deals.',
  },
  {
    attr: 'exploreDeals',
    label: '6 · Explore Deals',
    description: 'Tabbed deals grid (up to 8 category tabs) in the middle of the page.',
  },
  {
    attr: 'newlyAdded',
    label: '7 · Fresh Drops (newly added)',
    description: 'Tall coupon cards (354×646 images) for newly added stores and offers.',
  },
  {
    attr: 'dealsByBrand',
    label: '8 · Deals by Brand',
    description:
      'Deal strip LOWER ON THE PAGE, after Fresh Drops. Same layout as "4 · Top Deals" — ' +
      'that one is the strip near the top.',
  },
  {
    attr: 'bankOffers',
    label: '9 · Bank Offers',
    description: 'Bank & card offer tiles (up to 6) after Deals by Brand.',
  },
  {
    attr: 'latestInsightsEnabled',
    label: '10 · Show Latest Insights?',
    description:
      'Turns the Latest Insights blog section on or off. (Other sections have their own ' +
      '"enabled" toggle inside; this section\'s toggle lives here.)',
  },
  {
    attr: 'latestInsights',
    label: '10 · Latest Insights (blog)',
    description:
      'Heading and "view all" link for the blog teaser. Only shown when the toggle above is ON.',
  },
  {
    attr: 'howItWorks',
    label: '11 · How It Works',
    description:
      'Step-by-step explainer near the bottom. Every step needs a kind and a title, and every ' +
      '"why" feature needs a kind and a label — saves fail if they are empty.',
  },
  {
    attr: 'faq',
    label: '12 · FAQ',
    description: 'Frequently-asked-questions accordion near the bottom of the page.',
  },
  {
    attr: 'popularSearches',
    label: '13 · Popular Searches',
    description: 'Link list at the very bottom of the page, below the newsletter block.',
  },
  {
    attr: 'seo',
    label: 'SEO (search & social)',
    description:
      'Meta title, description and share image for the homepage — not visible on the page itself.',
  },
];
