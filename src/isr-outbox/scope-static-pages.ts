// STATIC-PAGE MAPPING for ISR scopes: which single-type/chrome UIDs render
// which fixed public slugs. One of the modules split out of scopes.ts,
// which keeps the computeScope coordinator.

export const CHROME_UIDS = new Set(['api::menu.menu', 'api::footer.footer', 'api::global.global']);

export const DOTD_PAGE_UID = 'api::deal-of-the-day-page.deal-of-the-day-page';
export const INDEPENDENCE_DAY_SALE_PAGE_UID =
  'api::independence-day-sale-page.independence-day-sale-page';
// The About page is a standalone editorial route with no entity relations, so
// an edit rebuilds exactly one page. Its country cards read from the Footer
// single type, which is in CHROME_UIDS and already triggers a full rebuild.
export const ABOUT_PAGE_UID = 'api::about-page.about-page';
export const ABOUT_PAGE_SLUG = 'about-us';
export const CAREER_PAGE_UID = 'api::career-page.career-page';
export const JOB_UID = 'api::job.job';
export const CAREER_PAGE_SLUG = 'careers';
export const CONTACT_PAGE_UID = 'api::contact-page.contact-page';
export const CONTACT_PAGE_SLUG = 'contact-us';
export const FAQ_PAGE_UID = 'api::faq-page.faq-page';
export const FAQ_PAGE_SLUG = 'faqs';
export const TESTIMONIALS_PAGE_UID = 'api::testimonials-page.testimonials-page';
export const TESTIMONIALS_PAGE_SLUG = 'testimonials';
export const PARTNER_WITH_US_PAGE_UID =
  'api::partner-with-us-page.partner-with-us-page';
export const PARTNER_WITH_US_PAGE_SLUG = 'partner-with-us';
export const PRIVACY_POLICY_PAGE_UID = 'api::privacy-policy-page.privacy-policy-page';
export const PRIVACY_POLICY_PAGE_SLUG = 'privacy-policy';
export const TERMS_PAGE_UID =
  'api::terms-and-conditions-page.terms-and-conditions-page';
export const TERMS_PAGE_SLUG = 'terms-and-conditions';
export const AFFILIATE_DISCLOSURE_PAGE_UID =
  'api::affiliate-disclosure-page.affiliate-disclosure-page';
export const AFFILIATE_DISCLOSURE_PAGE_SLUG = 'affiliate-disclosure';
export const CULTURE_PAGE_UID = 'api::culture-page.culture-page';
export const CULTURE_PAGE_SLUG = 'culture';

export const ERROR_PAGE_UID = 'api::error-page.error-page';

export const ERROR_DOCUMENT_SLUGS = [
  'error-pages/400',
  'error-pages/403',
  'error-pages/404',
  'error-pages/405',
  'error-pages/414',
  'error-pages/416',
  'error-pages/500',
  'error-pages/501',
  'error-pages/502',
  'error-pages/503',
  'error-pages/504',
  'error-pages/template',
] as const;
