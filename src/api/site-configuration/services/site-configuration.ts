import { assertDeploymentCountry, deploymentCountryCode } from '../../../utils/deployment-country';
import type { Core } from '@strapi/strapi';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import {
  isResolvableContentLocale,
  resolveContentLocale,
  selectableContentLocales,
} from '../../../translation/locales/resolve';
import {
  OFFER_COUNTRY_REGISTRY,
  enabledOfferCountryOptions,
  offerCountryByCode,
  parseOfferCountryTokens,
} from '../../../constants/offer-countries';
import {
  FEATURE_FIELDS,
  OFFER_COUNTRY_FIELDS,
  SITE_CONFIGURATION_FIELDS,
  SITE_CONFIGURATION_UID,
  TRANSLATION_FIELDS,
  normalizeSiteConfiguration,
  translationLocaleCodes,
  type SiteConfiguration,
} from './country-registry';
import { getFeatureReadiness } from './feature-readiness';
import { localizationPreview, validateLocalization } from './localization';
import { applyTranslationSettings } from './translation-hot-apply';

function safeFields(config: SiteConfiguration) {
  return Object.fromEntries(
    SITE_CONFIGURATION_FIELDS.filter((field) => field !== 'configurationRevision').map((field) => [field, config[field]]),
  );
}

export async function loadSiteConfiguration(
  strapi: Core.Strapi,
): Promise<SiteConfiguration> {
  const row = await strapi.documents(SITE_CONFIGURATION_UID as any).findFirst({
    fields: [...SITE_CONFIGURATION_FIELDS] as any,
  });
  let source = row;
  if (!source) {
    const { readCountryBootstrap, assertEmptyCountryDatabase } = require(require('node:path').join((strapi as any).dirs?.app?.root ?? process.cwd(), 'database/country-bootstrap.js'));
    const bootstrap = readCountryBootstrap(deploymentCountryCode());
    if (bootstrap) {
      await assertEmptyCountryDatabase(strapi.db.connection);
      source = { ...bootstrap, ...Object.fromEntries(FEATURE_FIELDS.map((field) => [field, false])) };
    }
  }
  const configuration = normalizeSiteConfiguration(source);
  assertDeploymentCountry(configuration.countryCode);
  return configuration;
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
    configurationRevision: config.configurationRevision ?? 0,
    localization: localizationPreview(
      config.locale,
      config.currencyCode,
      config.timezone,
      config.countryCode,
    ),
    languages: siteLanguages(config),
    // Derived from the `offerCountries` csv (which safeFields also carries,
    // for the Country Setup form): the enabled tags with display data and
    // their filter expansion. Empty array = the feature is off site-wide.
    offerCountryOptions: enabledOfferCountryOptions(config.offerCountries),
    features,
  };
}

/**
 * Raw Country Setup inputs that only the admin form needs. The storefront and
 * the deploy tooling consume the DERIVED `languages` and `offerCountryOptions`,
 * so the anonymous `GET /api/site-settings` body omits these: which languages
 * are paid-translated and which country tags are toggled is operator
 * configuration, not public data.
 */
const ADMIN_ONLY_SITE_SETTINGS_FIELDS = [
  ...TRANSLATION_FIELDS,
  ...OFFER_COUNTRY_FIELDS,
] as const;

export async function buildPublicSiteSettings(
  strapi: Core.Strapi,
  supplied?: SiteConfiguration,
) {
  const settings: Record<string, unknown> = await buildSiteSettings(strapi, supplied);
  for (const field of ADMIN_ONLY_SITE_SETTINGS_FIELDS) delete settings[field];
  return settings;
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

  // Judge the RAW submitted csv, not the candidate: normalizeSiteConfiguration
  // canonicalises `offerCountries` by dropping unknown tokens, so a typo would
  // silently vanish from the saved value instead of failing the save.
  if (data && Object.prototype.hasOwnProperty.call(data, 'offerCountries')) {
    const unknownCountries = parseOfferCountryTokens(data.offerCountries).filter(
      (code) => !offerCountryByCode(code),
    );
    if (unknownCountries.length > 0) {
      problems.push({
        path: ['offerCountries'],
        message:
          `Unknown offer country code(s): ${unknownCountries.join(', ')}. ` +
          `Pick from: ${OFFER_COUNTRY_REGISTRY.map((def) => def.code).join(', ')}.`,
      });
    }
  }

  assertDeploymentCountry(candidate.countryCode);
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

/**
 * The custom-field picker on Coupon/Deal edit forms: the ENABLED tags for
 * this deployment. Readable by any authenticated admin (editors tag offers);
 * the full-registry Country Setup picker stays Super-Admin-only.
 */
export async function enabledOfferCountries(strapi: Core.Strapi) {
  const config = await loadSiteConfiguration(strapi);
  return enabledOfferCountryOptions(config.offerCountries);
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  load: () => loadSiteConfiguration(strapi),
  /** Anonymous `GET /api/site-settings` and internal readers of derived data. */
  publicSettings: () => buildPublicSiteSettings(strapi),
  /** Admin Country Setup: the public body plus the raw form inputs. */
  adminSettings: () => buildSiteSettings(strapi),
  selectableLanguages: () => selectableSiteLanguages(strapi),
  /** Country Setup's country picker: the full master registry. */
  selectableOfferCountries: () =>
    OFFER_COUNTRY_REGISTRY.map(({ code, displayCode, name, kind }) => ({
      code,
      displayCode,
      name,
      kind,
    })),
  enabledOfferCountries: () => enabledOfferCountries(strapi),
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
    return buildSiteSettings(strapi);
  },
});
