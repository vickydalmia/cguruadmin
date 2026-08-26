export type FeatureState = {
  enabled: boolean;
  ready: boolean;
  live: boolean;
  reason?: string;
};

export type CountrySetup = {
  siteName: string;
  countryName: string;
  countryCode: string;
  locale: string;
  timezone: string;
  currencyCode: string;
  onboardingComplete: boolean;
  localization: {
    currencyCode: string;
    currencySymbol: string;
    numberExample: string;
    dateExample: string;
  };
  features: Record<string, FeatureState>;
  [field: string]: unknown;
};

export type FeatureFormDefinition = {
  key: string;
  field: string;
  label: string;
  group: 'Catalog' | 'Editorial' | 'Legal' | 'Campaigns';
  destinations: readonly string[];
};

export const FEATURE_FORM_DEFINITIONS: readonly FeatureFormDefinition[] = [
  { key: 'stores', field: 'storesEnabled', label: 'Stores', group: 'Catalog', destinations: ['/stores/'] },
  { key: 'coupons', field: 'couponsEnabled', label: 'Coupons', group: 'Catalog', destinations: ['/coupon/:id/'] },
  { key: 'brands', field: 'brandsEnabled', label: 'Brands', group: 'Catalog', destinations: ['/brands/'] },
  { key: 'categories', field: 'categoriesEnabled', label: 'Categories', group: 'Catalog', destinations: ['/categories/'] },
  { key: 'banks', field: 'banksEnabled', label: 'Banks', group: 'Catalog', destinations: ['/banks/'] },
  { key: 'productDeals', field: 'productDealsEnabled', label: 'Product Deals', group: 'Catalog', destinations: ['/deal/:id/'] },
  { key: 'about', field: 'aboutEnabled', label: 'About', group: 'Editorial', destinations: ['/about-us/'] },
  { key: 'careers', field: 'careersEnabled', label: 'Careers', group: 'Editorial', destinations: ['/careers/', '/careers/:slug/'] },
  { key: 'contact', field: 'contactEnabled', label: 'Contact', group: 'Editorial', destinations: ['/contact-us/'] },
  { key: 'faqs', field: 'faqsEnabled', label: 'FAQs', group: 'Editorial', destinations: ['/faqs/'] },
  { key: 'testimonials', field: 'testimonialsEnabled', label: 'Testimonials', group: 'Editorial', destinations: ['/testimonials/'] },
  { key: 'partnerWithUs', field: 'partnerWithUsEnabled', label: 'Partner With Us', group: 'Editorial', destinations: ['/partner-with-us/'] },
  { key: 'culture', field: 'cultureEnabled', label: 'Culture', group: 'Editorial', destinations: ['/culture/'] },
  { key: 'privacyPolicy', field: 'privacyPolicyEnabled', label: 'Privacy Policy', group: 'Legal', destinations: ['/privacy-policy/'] },
  { key: 'termsAndConditions', field: 'termsAndConditionsEnabled', label: 'Terms and Conditions', group: 'Legal', destinations: ['/terms-and-conditions/'] },
  { key: 'affiliateDisclosure', field: 'affiliateDisclosureEnabled', label: 'Affiliate Disclosure', group: 'Legal', destinations: ['/affiliate-disclosure/'] },
  { key: 'dealOfTheDay', field: 'dealOfTheDayEnabled', label: 'Deal of the Day', group: 'Campaigns', destinations: ['Entity template: dealTemplate'] },
  { key: 'independenceDaySale', field: 'independenceDaySaleEnabled', label: 'Independence Day Sale', group: 'Campaigns', destinations: ['Entity template: independenceDayTemplate'] },
] as const;

export const EDITABLE_IDENTITY_FIELDS = [
  'siteName',
  'countryName',
  'countryCode',
  'locale',
  'timezone',
  'currencyCode',
  'onboardingComplete',
] as const;
