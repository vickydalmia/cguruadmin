import type { Core } from '@strapi/strapi';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import {
  contentLocaleByCode,
  supportedContentLocaleCodes,
} from '../../../translation/locales/table';
import {
  SITE_CONFIGURATION_FIELDS,
  SITE_CONFIGURATION_UID,
  normalizeSiteConfiguration,
  translationLocaleCodes,
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

/**
 * The site's content languages for the frontend: the default language plus
 * every enabled, registry-known translation locale. The frontend derives
 * routing (`/ar/` prefix), `<html dir>`, og:locale and its switcher from
 * this — never from hardcoded lists.
 */
export function siteLanguages(config: SiteConfiguration) {
  const extra = translationLocaleCodes(config)
    .filter((code) => code !== DEFAULT_CONTENT_LOCALE)
    .map((code) => contentLocaleByCode(code))
    .filter((locale): locale is NonNullable<typeof locale> => Boolean(locale))
    .map((locale) => ({
      code: locale.code,
      name: locale.name,
      nativeName: locale.nativeName,
      dir: locale.dir,
      ogLocale: locale.ogLocale,
      default: false,
      pathPrefix: `/${locale.code}`,
    }));
  return [
    {
      code: DEFAULT_CONTENT_LOCALE,
      name: 'English',
      nativeName: 'English',
      dir: 'ltr' as const,
      // The regional og:locale (en_IN / en_AE) stays derived from
      // config.locale by the frontend's existing ogLocale() helper.
      ogLocale: null,
      default: true,
      pathPrefix: '',
    },
    ...extra,
  ];
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
    languages: siteLanguages(config),
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

  // Translation opt-in must name locales the registry can actually produce
  // (a prompt template exists). Unknown codes are a config typo — reject
  // loudly instead of silently running a zero-locale pipeline.
  const requestedLocales = translationLocaleCodes({
    translationEnabled: true,
    translationLocales: candidate.translationLocales,
  });
  const supported = new Set(supportedContentLocaleCodes());
  const unknown = requestedLocales.filter(
    (code) => code !== DEFAULT_CONTENT_LOCALE && !supported.has(code),
  );
  if (unknown.length > 0) {
    problems.push({
      path: ['translationLocales'],
      message:
        `Unsupported translation locale(s): ${unknown.join(', ')}. ` +
        `Supported: ${[...supported].join(', ') || '(none registered)'}.`,
    });
  }
  if (
    candidate.translationEnabled &&
    requestedLocales.filter((code) => code !== DEFAULT_CONTENT_LOCALE).length === 0
  ) {
    problems.push({
      path: ['translationLocales'],
      message:
        'Translation is enabled but no target locales are listed — add e.g. "ar", or turn translation off.',
    });
  }

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
