import type { SectionLabel } from './homepage-sections';

export const FESTIVAL_PAGE_UID = 'api::festival-page.festival-page';

export const FESTIVAL_SECTION_LABELS: SectionLabel[] = [
  { attr: 'enabled', label: 'Enable template', description: 'Off by default. Assigning an owner does not enable the template. Turn this on when you want the owner to render Festival, regardless of which sections are filled.' },
  { attr: 'title', label: 'Page title', description: 'Heading and breadcrumb label for the Festival page.' },
  { attr: 'countdown', label: '1 · Sale countdown', description: 'Optional clock. Supply valid start/end dates and working CTA URLs for both phases.' },
  { attr: 'hero', label: '2 · Festival banner', description: 'One desktop image fills the full viewport width on every screen. Height scales proportionally on smaller screens without cropping. Include badges in the image. No image means no banner; this does not affect template activation.' },
  { attr: 'offerSlider', label: '3 · Offer slider', description: 'Add and reorder Coupon slides (with or without a code). Empty overrides use the selected offer’s current content; no items means no slider.' },
  { attr: 'exploreCategories', label: '4 · Explore categories', description: 'Add and reorder any number of categories. Optional Coupon selections keep editorial order; empty selections use all latest live Coupons in that category. Search, filters and sorting run in the browser.' },
  { attr: 'seo', label: 'SEO (search & social)', description: 'Your Festival search and social metadata.' },
];
