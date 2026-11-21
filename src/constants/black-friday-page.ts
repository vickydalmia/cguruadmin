import type { SectionLabel } from './homepage-sections';

export const BLACK_FRIDAY_PAGE_UID = 'api::black-friday-page.black-friday-page';

export const BLACK_FRIDAY_SECTION_LABELS: SectionLabel[] = [
  { attr: 'enabled', label: 'Enable template', description: 'Assign Black Friday Template to one Store, Brand, Category or Bank, then turn this on. Off keeps that entity on its normal page. Only that entity shows the Black Friday design.' },
  { attr: 'title', label: 'Page title', description: 'Campaign name for the breadcrumb and accessible page heading. This does not replace the owner entity’s SEO title.' },
  { attr: 'hero', label: '1 · Hero and countdown', description: 'Headline, offer claim, buttons, sale end time and up to 3 merchant tickets. Enter only claims you can verify. The clock disappears after the end time.' },
  { attr: 'ticker', label: '2 · Ticker bands', description: 'Separate phrases with a vertical bar, for example BLACK FRIDAY | EXTRA BANK OFFERS. Empty hides that band.' },
  { attr: 'topBrands', label: '3 · Top brands', description: 'Add Stores or Brands in display order. Select one merchant per row. Discount text is shown exactly as entered.' },
  { attr: 'featured', label: '4 · Featured Coupons · Maximum 5', description: 'The first live Coupon is the large card and the next four are small cards. Code and no-code Coupons are supported. Product Deals belong in section 6.' },
  { attr: 'exploreCategories', label: '5 · Every deal, one place', description: 'Add categories in order. Optional Coupon selections keep editorial order; empty selections show the newest 24 live Coupons in that category.' },
  { attr: 'productSection', label: '6 · Product Deals', description: 'Add category tabs to list live Product Deals. Each category shows its newest 24 live Deals, with filters and Load More.' },
  { attr: 'faq', label: '7 · Frequently asked questions', description: 'Enable and add questions for this page. Empty or disabled hides this section.' },
  { attr: 'popularSearches', label: '8 · Popular searches', description: 'Select Stores, Brands, Categories or Banks to link below the FAQs.' },
];
