// Editor-facing labels and help text for the Homepage single type, numbered in
// LIVE page render order (cguru-ui features/home/home.astro) — note Popular
// Stores renders BEFORE Top Offers, unlike the schema order.
// Consumed by BOTH the server bootstrap (src/index.ts pins them into the
// content-manager view config) and the admin bundle (src/admin/app.tsx uses
// the labels in the validation-problems side panel) — keep it dependency-free.
export const HOMEPAGE_UID = 'api::homepage.homepage';

export type SectionLabel = {
  attr: string;
  label: string;
  description: string;
};

// Back-compat alias (admin bundle imports the original name).
export type HomepageSectionLabel = SectionLabel;

export const HOMEPAGE_SECTION_LABELS: SectionLabel[] = [
  {
    attr: 'title',
    label: 'Admin title',
    description: 'Internal name shown in the admin only — never appears on the site.',
  },
  {
    attr: 'hero',
    label: '1 · Hero — banner slider & products',
    description:
      'Top of the page: banner slider (1664×720 images) plus up to 4 product cards beside it.',
  },
  {
    attr: 'popularStores',
    label: '2 · Popular Stores',
    description:
      'Store row directly under the hero: one featured store plus up to 24 popular stores.',
  },
  {
    attr: 'topOffers',
    label: '3 · Top Offers',
    description:
      'Latest coupon banner cards (up to 8, 584×356 images) after Popular Stores. ' +
      'The site shows 4; the extras backfill automatically when an offer expires.',
  },
  {
    attr: 'topDeals',
    label: '4 · Top Deals',
    description:
      'Product Deal cards (up to 10) from the "Deals Of The Day" category. ' +
      'The site shows 6; the extras backfill automatically when a deal expires.',
  },
  {
    attr: 'cgExclusive',
    label: '5 · CG Exclusive',
    description:
      'Coupon banners (up to 8, 768×370 images) from the "Exclusive Coupons" category. ' +
      'The site shows 4; the extras backfill automatically when an offer expires.',
  },
  {
    attr: 'exploreOffers',
    label: '6 · Explore Offers',
    description:
      'Tabbed Coupon-offer grid (up to 8 category tabs, up to 10 offers each). ' +
      'The site shows 6 per tab; the extras backfill automatically when offers expire.',
  },
  {
    attr: 'newlyAdded',
    label: '7 · Fresh Drops (newly added)',
    description:
      'Tall cards (up to 8, 354×646 images) showing the latest coupons. ' +
      'The site shows 4; the extras backfill automatically when an offer expires.',
  },
  {
    attr: 'offersByBrand',
    label: '8 · Offers by Brand',
    description:
      'Coupon offers associated with brands (up to 7). The site shows 3; ' +
      'the extras backfill automatically when an offer expires.',
  },
  {
    attr: 'bankOffers',
    label: '9 · Bank Offers',
    description:
      'Up to 12 bank tiles — banks with the most published coupons first, then ' +
      'zero-coupon banks alphabetically. The site shows 8. Each tile links to that bank\'s page.',
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
    description:
      'Switch the section on, then select Stores, Brands, Categories, or Banks. ' +
      'Selected entities become canonical Popular Searches links at the bottom of the page.',
  },
  {
    attr: 'exploreDeals',
    label: 'Legacy · Explore Deals (temporary fallback)',
    description:
      'Deprecated Deal-schema content retained for one compatibility release. Populate Explore Offers instead.',
  },
  {
    attr: 'dealsByBrand',
    label: 'Legacy · Deals by Brand (temporary fallback)',
    description:
      'Deprecated Deal-schema content retained for one compatibility release. Populate Offers by Brand instead.',
  },
  {
    attr: 'seo',
    label: 'SEO (search & social)',
    description:
      'Meta title, description and share image for the homepage — not visible on the page itself.',
  },
];
