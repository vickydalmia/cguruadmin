import type { Core } from '@strapi/strapi';

import { findEntityTemplateOwners } from './entity-template-owners';
import type { FeatureField, SiteConfiguration } from './country-registry';
import { loadSiteConfiguration } from './site-configuration';

type FeatureContentTypes = {
  flag: FeatureField;
  uids: readonly string[];
};

const FEATURE_CONTENT_TYPES: readonly FeatureContentTypes[] = [
  { flag: 'storesEnabled', uids: ['api::store.store'] },
  {
    flag: 'couponsEnabled',
    uids: [
      'api::coupon.coupon',
      'api::unique-code.unique-code',
      'api::unique-coupon-pool.unique-coupon-pool',
    ],
  },
  { flag: 'brandsEnabled', uids: ['api::brand.brand'] },
  { flag: 'categoriesEnabled', uids: ['api::category.category'] },
  { flag: 'banksEnabled', uids: ['api::bank.bank'] },
  { flag: 'productDealsEnabled', uids: ['api::deal.deal'] },
  { flag: 'aboutEnabled', uids: ['api::about-page.about-page'] },
  {
    flag: 'careersEnabled',
    uids: ['api::career-page.career-page', 'api::job.job'],
  },
  { flag: 'contactEnabled', uids: ['api::contact-page.contact-page'] },
  { flag: 'faqsEnabled', uids: ['api::faq-page.faq-page'] },
  {
    flag: 'testimonialsEnabled',
    uids: ['api::testimonials-page.testimonials-page'],
  },
  {
    flag: 'partnerWithUsEnabled',
    uids: ['api::partner-with-us-page.partner-with-us-page'],
  },
  { flag: 'cultureEnabled', uids: ['api::culture-page.culture-page'] },
  {
    flag: 'privacyPolicyEnabled',
    uids: ['api::privacy-policy-page.privacy-policy-page'],
  },
  {
    flag: 'termsAndConditionsEnabled',
    uids: ['api::terms-and-conditions-page.terms-and-conditions-page'],
  },
  {
    flag: 'affiliateDisclosureEnabled',
    uids: ['api::affiliate-disclosure-page.affiliate-disclosure-page'],
  },
] as const;

const CAMPAIGN_CONTENT_TYPES = {
  dealTemplate: 'api::deal-of-the-day-page.deal-of-the-day-page',
  independenceDayTemplate:
    'api::independence-day-sale-page.independence-day-sale-page',
} as const;

export type AdminCampaignOwnership = {
  dealTemplate: boolean;
  independenceDayTemplate: boolean;
};

/**
 * Content types remain registered and their data remains untouched. This set
 * only controls which links Content Manager returns for the current country.
 */
export function hiddenAdminContentTypeUids(
  config: SiteConfiguration,
  campaignOwnership: AdminCampaignOwnership,
): Set<string> {
  const hidden = new Set<string>();

  for (const feature of FEATURE_CONTENT_TYPES) {
    if (config[feature.flag]) continue;
    for (const uid of feature.uids) hidden.add(uid);
  }

  for (const [template, uid] of Object.entries(CAMPAIGN_CONTENT_TYPES)) {
    if (!campaignOwnership[template as keyof AdminCampaignOwnership]) {
      hidden.add(uid);
    }
  }

  return hidden;
}

export async function filterContentManagerInitBody(
  strapi: Core.Strapi,
  body: any,
): Promise<any> {
  const contentTypes = body?.data?.contentTypes;
  if (!Array.isArray(contentTypes)) return body;

  const [config, dealOwners, independenceDayOwners] = await Promise.all([
    loadSiteConfiguration(strapi),
    findEntityTemplateOwners(strapi, 'dealTemplate'),
    findEntityTemplateOwners(strapi, 'independenceDayTemplate'),
  ]);
  const hidden = hiddenAdminContentTypeUids(config, {
    dealTemplate: dealOwners.length > 0,
    independenceDayTemplate: independenceDayOwners.length > 0,
  });

  return {
    ...body,
    data: {
      ...body.data,
      contentTypes: contentTypes.map((contentType: any) =>
        hidden.has(contentType?.uid)
          ? { ...contentType, isDisplayed: false }
          : contentType,
      ),
    },
  };
}
