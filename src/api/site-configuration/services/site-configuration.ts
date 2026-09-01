import type { Core } from '@strapi/strapi';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import {
  isResolvableContentLocale,
  resolveContentLocale,
  selectableContentLocales,
} from '../../../translation/locales/resolve';
import {
  SITE_CONFIGURATION_FIELDS,
  SITE_CONFIGURATION_UID,
  normalizeSiteConfiguration,
  translationLocaleCodes,
  type SiteConfiguration,
} from './country-registry';
import { getFeatureReadiness } from './feature-readiness';
import { localizationPreview, validateLocalization } from './localization';
import { applyTranslationSettings } from './translation-hot-apply';

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
 * every enabled translation locale ICU can resolve, bound to this site's
 * country (og:locale = `code_COUNTRY`). The frontend derives routing
 * (`/ar/` prefix), `<html dir>`, og:locale and its switcher from this —
 * never from hardcoded lists.
 */
export function siteLanguages(config: SiteConfiguration) {
  const site = { countryCode: config.countryCode, countryName: config.countryName };
  const extra = translationLocaleCodes(config)
    .filter((code) => code !== DEFAULT_CONTENT_LOCALE)
    .map((code) => resolveContentLocale(code, site))
    .filter((locale): locale is NonNullable<typeof locale> => locale !== null)
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

  // Translation opt-in must name languages the resolver can actually
  // produce (ICU names the code, so prompts, direction and og:locale exist).
  // Unknown codes are a config typo and English is the source, never a
  // target — reject loudly instead of silently running a zero-locale pipeline.
  const requestedLocales = translationLocaleCodes({
    translationEnabled: true,
    translationLocales: candidate.translationLocales,
  });
  const unknown = requestedLocales.filter(
    (code) => !isResolvableContentLocale(code),
  );
  if (unknown.length > 0) {
    problems.push({
      path: ['translationLocales'],
      message:
        `Unsupported translation locale(s): ${unknown.join(', ')}. ` +
        'Each target must be an ISO 639-1 two-letter language code ICU can ' +
        `name (for example "ar" or "hi"); "${DEFAULT_CONTENT_LOCALE}" is the ` +
        'source language and cannot be a target.',
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

/** Country Setup's language picker: every language ICU can resolve for this site. */
export async function selectableSiteLanguages(strapi: Core.Strapi) {
  const config = await loadSiteConfiguration(strapi);
  return selectableContentLocales(config).map(
    ({ code, name, nativeName, dir, script }) => ({
      code,
      name,
      nativeName,
      dir,
      script,
    }),
  );
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  load: () => loadSiteConfiguration(strapi),
  publicSettings: () => buildSiteSettings(strapi),
  selectableLanguages: () => selectableSiteLanguages(strapi),
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
    // The row is committed; bring THIS process in line with it (locale rows,
    // sync mirror, dispatcher). Logged-and-swallowed inside — a hot-apply
    // problem must never turn a successful save into an error response.
    await applyTranslationSettings(strapi);
    return buildSiteSettings(strapi, candidate);
  },
});
