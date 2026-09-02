import { canonicalOfferCountries } from '../../../constants/offer-countries';

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
  /**
   * AI content translation. `translationEnabled` is the master switch;
   * `translationLocales` is a csv of CONTENT locale codes to translate into
   * (bare codes such as "ar" — a different axis from `locale`, which is the
   * regional formatting locale like "en-AE"). Both default off/empty so
   * every deployment without an explicit opt-in stays untouched.
   */
  translationEnabled: boolean;
  translationLocales: string;
  /**
   * Per-offer country tagging (flag pills + entity-page Country filter): a
   * csv of OFFER_COUNTRY_REGISTRY codes editors may tag Coupons/Deals with
   * (e.g. "AE,SA,KW,GCC"). Empty = the whole feature is off, which is the
   * India/USA state. Codes, not names — the registry owns display data.
   */
  offerCountries: string;
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
  /** Country Setup switch. Campaign templates are activated by their entity owner instead. */
  flag?: FeatureField;
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
  { key: 'dealOfTheDay', label: 'Deal of the Day', group: 'Campaigns', paths: [], pageTemplate: 'dealTemplate', sourceUid: 'api::deal-of-the-day-page.deal-of-the-day-page', sourceFields: ['heroTitle'] },
  { key: 'independenceDaySale', label: 'Independence Day Sale', group: 'Campaigns', paths: [], pageTemplate: 'independenceDayTemplate', sourceUid: 'api::independence-day-sale-page.independence-day-sale-page', sourceFields: ['hero', 'countdown'] },
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
  translationEnabled: false,
  translationLocales: '',
  offerCountries: '',
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

export const TRANSLATION_FIELDS = [
  'translationEnabled',
  'translationLocales',
] as const;

export const OFFER_COUNTRY_FIELDS = ['offerCountries'] as const;

export const SITE_CONFIGURATION_FIELDS = [
  ...IDENTITY_FIELDS,
  ...TRANSLATION_FIELDS,
  ...OFFER_COUNTRY_FIELDS,
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
  normalized.translationEnabled = normalized.translationEnabled === true;
  normalized.translationLocales = normalizeTranslationLocales(
    normalized.translationLocales,
  );
  // Unknown tokens are dropped HERE (canonical spelling only); the write
  // validator reports them by name before this ever persists.
  normalized.offerCountries = canonicalOfferCountries(normalized.offerCountries);
  for (const field of FEATURE_FIELDS) normalized[field] = normalized[field] === true;
  return normalized;
}

/**
 * Canonical csv of content locale codes: lowercased, trimmed, deduped, empty
 * tokens dropped. Whether a code is actually SUPPORTED (has a prompt
 * template) is the translation locale registry's call — this only makes the
 * stored value deterministic.
 */
export function normalizeTranslationLocales(value: unknown): string {
  const tokens = String(value ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(token));
  return [...new Set(tokens)].join(',');
}

export function translationLocaleCodes(
  configuration: Pick<SiteConfiguration, 'translationEnabled' | 'translationLocales'>,
): string[] {
  if (configuration.translationEnabled !== true) return [];
  const csv = normalizeTranslationLocales(configuration.translationLocales);
  return csv ? csv.split(',') : [];
}

export function featureByPath(path: string): FeatureDefinition | undefined {
  return FEATURE_REGISTRY.find((feature) => feature.paths.includes(path));
}
