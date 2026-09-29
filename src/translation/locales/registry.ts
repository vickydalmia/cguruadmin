import type { Core } from '@strapi/strapi';
import {
  translationLocaleCodes,
} from '../../api/site-configuration/services/country-registry';
import { cachedSiteConfiguration } from '../../api/site-configuration/services/cached-configuration';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import { resolveContentLocale, type ContentLocale } from './resolve';

// The resolver lives in ./resolve (import-free) so site-configuration's
// payload builder can read it without a cycle; this module owns everything
// that needs `strapi`.

/**
 * The locales THIS deployment translates into: every code the admin picked
 * in Country Setup that ICU can resolve, bound to the site's country so
 * og:locale and the prompt context are right. Codes that no longer resolve
 * are reported by site-configuration validation at save time; here they are
 * simply dropped so a stale stored value can never invent a pipeline.
 * Returns [] whenever translation is off — the subsystem's inert state.
 */
export async function enabledContentLocales(
  strapi: Core.Strapi,
): Promise<ContentLocale[]> {
  const configuration = await cachedSiteConfiguration(strapi);
  const site = {
    countryCode: configuration.countryCode,
    countryName: configuration.countryName,
  };
  return translationLocaleCodes(configuration)
    .filter((code) => code !== DEFAULT_CONTENT_LOCALE)
    .map((code) => resolveContentLocale(code, site))
    .filter((locale): locale is ContentLocale => locale !== null);
}

// Boot-primed sync mirror for hot paths that cannot await (the ISR outbox
// insert runs inside write transactions). Enabling/disabling translation
// is propagated by the configuration watcher at most every 15 seconds.
let activeLocaleCodes: readonly string[] = [];

export async function primeEnabledContentLocales(
  strapi: Core.Strapi,
): Promise<void> {
  activeLocaleCodes = (await enabledContentLocales(strapi)).map(
    (locale) => locale.code,
  );
}

export function enabledContentLocaleCodesSync(): readonly string[] {
  return activeLocaleCodes;
}

/** Test hook. */
export function setEnabledContentLocaleCodesForTest(codes: string[]): void {
  activeLocaleCodes = codes;
}
