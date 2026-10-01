import type { SectionLabel } from './homepage-sections';

export const FESTIVAL_PAGE_UID = 'api::festival-page.festival-page';

export const FESTIVAL_SECTION_LABELS: SectionLabel[] = [
  { attr: 'enabled', label: 'Enable template', description: 'Off by default. Assigning an owner does not enable the template. Turn this on when you want the owner to render Festival, regardless of which sections are filled.' },
  { attr: 'title', label: 'Page title', description: 'Heading and breadcrumb label for the Festival page.' },
  { attr: 'countdown', label: '1 · Sale countdown', description: 'Optional clock. Supply valid start/end dates and working CTA URLs for both phases.' },
  { attr: 'hero', label: '2 · Festival banner', description: 'One desktop image fills the full viewport width on every screen. Height scales proportionally on smaller screens without cropping. Include badges in the image. No image means no banner; this does not affect template activation.' },
  { attr: 'offerSlider', label: '3 · Offer slider', description: 'Add and reorder Coupon slides (with or without a code). Empty overrides use the selected offer’s current content; no items means no slider.' },
  { attr: 'exploreCategories', label: '4 · Explore categories', description: 'Add and reorder any number of categories. Optional Coupon selections keep editorial order; empty selections use all latest live Coupons in that category. Search, filters and sorting run in the browser.' },
  { attr: 'savingsSection', label: '5 · Savings Coupons · Maximum 2', description: 'Select up to two Coupons. Override logo, title, description, all badge lines, button label and T&C text. Mobile displays a slider; desktop displays both cards.' },
  { attr: 'productSection', label: '6 · Picked for you · Product Deals', description: 'Select and reorder Product Deals. Prices, discounts, product images and merchant logos use live Deal data. Optional title overrides change only this section. Category tiles use their generated /category-name-deals/ pages unless a URL override is entered; upload their artwork here. The listing shows the latest 50 live Deals by default, with 8 more per click. Configure optional brand, store and bank filter choices inside this section; only choices with matching live Deals appear. Discount ranges are generated automatically by the storefront.' },
  { attr: 'giftSection', label: '7 · Festival Gift Offers · Coupons', description: 'Select the exact Coupons to show and drag to reorder. Only selected live Coupons appear; an empty selection hides the slider. Categories control only the tiles below. Upload category artwork and optionally override category titles and Coupon display content. This section appears above Telegram.' },
  { attr: 'faq', label: '8 · Frequently asked questions', description: 'Add and reorder questions and answers for this Festival page. Uses the shared FAQ accordion; empty or disabled sections stay hidden.' },
  { attr: 'popularSearches', label: '9 · Popular searches', description: 'Select stores, brands, categories and banks to link below the Festival FAQs. These selections belong to this page; empty or disabled sections stay hidden.' },
];
