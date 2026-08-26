import type { Core } from '@strapi/strapi';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import {
  SITE_CONFIGURATION_FIELDS,
  SITE_CONFIGURATION_UID,
  normalizeSiteConfiguration,
  type SiteConfiguration,
} from './country-registry';
import { getFeatureReadiness } from './feature-readiness';
import { localizationPreview, validateLocalization } from './localization';

function safeFields(config: SiteConfiguration) {
  return Object.fromEntries(
    SITE_CONFIGURATION_FIELDS.map((field) => [field, config[field]]),
  );
}

export async function loadSiteConfiguration(
  strapi: Core.Strapi,
): Promise<SiteConfiguration> {
  const row = await strapi.documents(SITE_CONFIGURATION_UID as any).findFirst({
    fields: [...SITE_CONFIGURATION_FIELDS] as any,
  });
  return normalizeSiteConfiguration(row);
}

export async function buildSiteSettings(
  strapi: Core.Strapi,
  supplied?: SiteConfiguration,
) {
  const config = supplied ?? (await loadSiteConfiguration(strapi));
  const features = await getFeatureReadiness(strapi, config);
  return {
    ...safeFields(config),
    localization: localizationPreview(
      config.locale,
      config.currencyCode,
      config.timezone,
      config.countryCode,
    ),
    features,
  };
}

export async function validateSiteConfigurationForWrite(
  strapi: Core.Strapi,
  data: any,
  documentId?: string,
): Promise<SiteConfiguration> {
  const existing = documentId
    ? await strapi.documents(SITE_CONFIGURATION_UID as any).findOne({
        documentId,
        fields: [...SITE_CONFIGURATION_FIELDS] as any,
      })
    : await strapi.documents(SITE_CONFIGURATION_UID as any).findFirst({
        fields: [...SITE_CONFIGURATION_FIELDS] as any,
      });
  const candidate = normalizeSiteConfiguration({ ...existing, ...data });
  validateLocalization(candidate);

  const problems: Problem[] = [];
  if (!candidate.siteName.trim()) problems.push({ path: ['siteName'], message: 'Site name is required.' });
  if (!candidate.countryName.trim()) problems.push({ path: ['countryName'], message: 'Country name is required.' });
  if (!/^[A-Z]{2}$/.test(candidate.countryCode)) problems.push({ path: ['countryCode'], message: 'Use a two-letter uppercase ISO country code.' });

  if (problems.length > 0) throw toValidationError(problems);
  return candidate;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  load: () => loadSiteConfiguration(strapi),
  publicSettings: () => buildSiteSettings(strapi),
  async update(data: any) {
    const current = await strapi.documents(SITE_CONFIGURATION_UID as any).findFirst({
      fields: ['documentId', ...SITE_CONFIGURATION_FIELDS] as any,
    });
    const candidate = await validateSiteConfigurationForWrite(
      strapi,
      data,
      (current as any)?.documentId,
    );
    if ((current as any)?.documentId) {
      await strapi.documents(SITE_CONFIGURATION_UID as any).update({
        documentId: (current as any).documentId,
        data: safeFields(candidate) as any,
      });
    } else {
      await strapi.documents(SITE_CONFIGURATION_UID as any).create({
        data: safeFields(candidate) as any,
      });
    }
    return buildSiteSettings(strapi, candidate);
  },
});
