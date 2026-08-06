import type { SectionLabel } from './homepage-sections';

export const INDEPENDENCE_DAY_SALE_UID =
  'api::independence-day-sale-page.independence-day-sale-page';
export const INDEPENDENCE_DAY_SALE_SLUG = 'independence-day-sale-coupons';

export const INDEPENDENCE_DAY_SALE_CAPS = {
  topPicks: 4,
  categoryTabs: 4,
  perTab: 10,
  allCoupons: 100,
  allDeals: 100,
} as const;

export const INDEPENDENCE_DAY_SALE_SECTION_LABELS: SectionLabel[] = [
  {
    attr: 'title',
    label: 'Admin title',
    description: 'Internal name shown in the admin only.',
  },
  {
    attr: 'countdown',
    label: '1 · Sale countdown',
    description: 'Switch the live clock on or off. Dates and labels are required only while the clock is enabled.',
  },
  {
    attr: 'hero',
    label: '2 · Independence Day hero',
    description: 'One required responsive campaign image with accessible alt text. Its aspect ratio is preserved at every viewport.',
  },
  {
    attr: 'topPicks',
    label: '3 · Coupon Top Picks',
    description: 'Coupon-schema records only. Add up to 4; the site renders the first 2 live Coupons.',
  },
  {
    attr: 'couponsByCategory',
    label: '4 · Explore by Category',
    description: 'Add up to 4 Coupon tabs. Each tab can use its own image override; empty offer relations auto-fill from the selected Category.',
  },
  {
    attr: 'productDealsByCategory',
    label: '5 · Top Product Deals',
    description: 'Dedicated Deal-schema tabs. Empty tab relations auto-fill from the selected Category.',
  },
  {
    attr: 'promoStrip',
    label: '6 · Flash Deals banner',
    description: 'Campaign strip between Product Deals and Store Coupons.',
  },
  {
    attr: 'couponsByStore',
    label: '7 · Explore by Stores',
    description: 'Coupon tabs. Empty tab relations auto-fill from the selected Store.',
  },
  {
    attr: 'allCoupons',
    label: '8 · All Coupons',
    description: 'Selected Coupons are authoritative. Leave empty to show the latest 100 live Coupons sitewide, ordered by Published date.',
  },
  {
    attr: 'allDeals',
    label: '9 · All Deals',
    description: 'Selected product Deals are authoritative. Leave empty to show the latest 100 live Deals sitewide, ordered by Published date.',
  },
  {
    attr: 'popularSearches',
    label: '10 · Popular Searches',
    description: 'Existing Store, Brand, Category and Bank relations rendered near the footer.',
  },
  {
    attr: 'seo',
    label: 'SEO (search & social)',
    description: 'Meta title, description and share image for this page.',
  },
];
