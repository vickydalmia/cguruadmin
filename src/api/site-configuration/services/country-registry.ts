export const SITE_CONFIGURATION_UID =
  'api::site-configuration.site-configuration' as const;

export const FEATURE_FIELDS = [
  'storesEnabled',
  'couponsEnabled',
  'brandsEnabled',
  'categoriesEnabled',
  'banksEnabled',
  'productDealsEnabled',
  'aboutEnabled',
  'careersEnabled',
  'contactEnabled',
  'faqsEnabled',
  'testimonialsEnabled',
  'partnerWithUsEnabled',
  'cultureEnabled',
  'privacyPolicyEnabled',
  'termsAndConditionsEnabled',
  'affiliateDisclosureEnabled',
  'dealOfTheDayEnabled',
  'independenceDaySaleEnabled',
] as const;

export type FeatureField = (typeof FEATURE_FIELDS)[number];

export type SiteConfiguration = {
  documentId?: string;
  siteName: string;
  countryName: string;
  countryCode: string;
  locale: string;
  timezone: string;
  currencyCode: string;
  onboardingComplete: boolean;
} & Record<FeatureField, boolean>;

export type FeatureKey =
  | 'stores'
  | 'coupons'
  | 'brands'
  | 'categories'
  | 'banks'
  | 'productDeals'
  | 'about'
  | 'careers'
  | 'contact'
  | 'faqs'
  | 'testimonials'
  | 'partnerWithUs'
  | 'culture'
  | 'privacyPolicy'
  | 'termsAndConditions'
  | 'affiliateDisclosure'
  | 'dealOfTheDay'
  | 'independenceDaySale';

export type FeatureDefinition = {
  key: FeatureKey;
  label: string;
  group: 'Catalog' | 'Editorial' | 'Legal' | 'Campaigns';
  flag: FeatureField;
  paths: readonly string[];
  sourceUid?: string;
  sourceFields?: readonly string[];
  catalogUid?: string;
  pageTemplate?: 'dealTemplate' | 'independenceDayTemplate';
};

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [
  { key: 'stores', label: 'Stores', group: 'Catalog', flag: 'storesEnabled', paths: ['/stores/'], catalogUid: 'api::store.store' },
  { key: 'coupons', label: 'Coupons', group: 'Catalog', flag: 'couponsEnabled', paths: [], catalogUid: 'api::coupon.coupon' },
  { key: 'brands', label: 'Brands', group: 'Catalog', flag: 'brandsEnabled', paths: ['/brands/'], catalogUid: 'api::brand.brand' },
  { key: 'categories', label: 'Categories', group: 'Catalog', flag: 'categoriesEnabled', paths: ['/categories/'], catalogUid: 'api::category.category' },
  { key: 'banks', label: 'Banks', group: 'Catalog', flag: 'banksEnabled', paths: ['/banks/'], catalogUid: 'api::bank.bank' },
  { key: 'productDeals', label: 'Product Deals', group: 'Catalog', flag: 'productDealsEnabled', paths: [], catalogUid: 'api::deal.deal' },
  { key: 'about', label: 'About', group: 'Editorial', flag: 'aboutEnabled', paths: ['/about-us/'], sourceUid: 'api::about-page.about-page', sourceFields: ['hero'] },
  { key: 'careers', label: 'Careers', group: 'Editorial', flag: 'careersEnabled', paths: ['/careers/'], sourceUid: 'api::career-page.career-page', sourceFields: ['hero', 'jobsSection'] },
  { key: 'contact', label: 'Contact', group: 'Editorial', flag: 'contactEnabled', paths: ['/contact-us/'], sourceUid: 'api::contact-page.contact-page', sourceFields: ['hero', 'form'] },
  { key: 'faqs', label: 'FAQs', group: 'Editorial', flag: 'faqsEnabled', paths: ['/faqs/'], sourceUid: 'api::faq-page.faq-page', sourceFields: ['heading', 'categories'] },
  { key: 'testimonials', label: 'Testimonials', group: 'Editorial', flag: 'testimonialsEnabled', paths: ['/testimonials/'], sourceUid: 'api::testimonials-page.testimonials-page', sourceFields: ['hero'] },
  { key: 'partnerWithUs', label: 'Partner With Us', group: 'Editorial', flag: 'partnerWithUsEnabled', paths: ['/partner-with-us/'], sourceUid: 'api::partner-with-us-page.partner-with-us-page', sourceFields: ['hero', 'cta'] },
  { key: 'culture', label: 'Culture', group: 'Editorial', flag: 'cultureEnabled', paths: ['/culture/'], sourceUid: 'api::culture-page.culture-page', sourceFields: ['hero'] },
  { key: 'privacyPolicy', label: 'Privacy Policy', group: 'Legal', flag: 'privacyPolicyEnabled', paths: ['/privacy-policy/'], sourceUid: 'api::privacy-policy-page.privacy-policy-page', sourceFields: ['heading', 'sections'] },
  { key: 'termsAndConditions', label: 'Terms and Conditions', group: 'Legal', flag: 'termsAndConditionsEnabled', paths: ['/terms-and-conditions/'], sourceUid: 'api::terms-and-conditions-page.terms-and-conditions-page', sourceFields: ['heading', 'sections'] },
  { key: 'affiliateDisclosure', label: 'Affiliate Disclosure', group: 'Legal', flag: 'affiliateDisclosureEnabled', paths: ['/affiliate-disclosure/'], sourceUid: 'api::affiliate-disclosure-page.affiliate-disclosure-page', sourceFields: ['heading', 'sections'] },
  { key: 'dealOfTheDay', label: 'Deal of the Day', group: 'Campaigns', flag: 'dealOfTheDayEnabled', paths: [], pageTemplate: 'dealTemplate', sourceUid: 'api::deal-of-the-day-page.deal-of-the-day-page', sourceFields: ['heroTitle'] },
  { key: 'independenceDaySale', label: 'Independence Day Sale', group: 'Campaigns', flag: 'independenceDaySaleEnabled', paths: [], pageTemplate: 'independenceDayTemplate', sourceUid: 'api::independence-day-sale-page.independence-day-sale-page', sourceFields: ['hero', 'countdown'] },
] as const;

export const INDIA_DEFAULT_CONFIGURATION: SiteConfiguration = {
  siteName: 'CouponzGuru',
  countryName: 'India',
  countryCode: 'IN',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  currencyCode: 'INR',
  onboardingComplete: false,
  storesEnabled: true,
  couponsEnabled: true,
  brandsEnabled: true,
  categoriesEnabled: true,
  banksEnabled: true,
  productDealsEnabled: true,
  aboutEnabled: true,
  careersEnabled: true,
  contactEnabled: true,
  faqsEnabled: true,
  testimonialsEnabled: true,
  partnerWithUsEnabled: true,
  cultureEnabled: true,
  privacyPolicyEnabled: true,
  termsAndConditionsEnabled: true,
  affiliateDisclosureEnabled: true,
  dealOfTheDayEnabled: true,
  independenceDaySaleEnabled: true,
};

export const IDENTITY_FIELDS = [
  'siteName',
  'countryName',
  'countryCode',
  'locale',
  'timezone',
  'currencyCode',
  'onboardingComplete',
] as const;

export const SITE_CONFIGURATION_FIELDS = [
  ...IDENTITY_FIELDS,
  ...FEATURE_FIELDS,
] as const;

export function normalizeSiteConfiguration(value: any): SiteConfiguration {
  const merged = { ...INDIA_DEFAULT_CONFIGURATION, ...(value ?? {}) } as any;
  const normalized = {
    ...INDIA_DEFAULT_CONFIGURATION,
    ...Object.fromEntries(
      SITE_CONFIGURATION_FIELDS.map((field) => [field, merged[field]]),
    ),
    ...(typeof value?.documentId === 'string'
      ? { documentId: value.documentId }
      : {}),
  } as SiteConfiguration;
  normalized.siteName = String(normalized.siteName ?? '').trim();
  normalized.countryName = String(normalized.countryName ?? '').trim();
  normalized.countryCode = String(normalized.countryCode ?? '').trim().toUpperCase();
  normalized.locale = String(normalized.locale ?? '').trim();
  normalized.timezone = String(normalized.timezone ?? '').trim();
  normalized.currencyCode = String(normalized.currencyCode ?? '').trim().toUpperCase();
  normalized.onboardingComplete = normalized.onboardingComplete === true;
  for (const field of FEATURE_FIELDS) normalized[field] = normalized[field] === true;
  return normalized;
}

export function featureByPath(path: string): FeatureDefinition | undefined {
  return FEATURE_REGISTRY.find((feature) => feature.paths.includes(path));
}
