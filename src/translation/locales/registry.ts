import type { Core } from '@strapi/strapi';
import {
  translationLocaleCodes,
} from '../../api/site-configuration/services/country-registry';
import { cachedSiteConfiguration } from '../../api/site-configuration/services/cached-configuration';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import { contentLocaleByCode, type ContentLocale } from './table';

// The static table lives in ./table (import-free) so site-configuration's
// payload builder can read it without a cycle; this module owns everything
// that needs `strapi`.
export {
  CONTENT_LOCALE_REGISTRY,
  contentLocaleByCode,
  supportedContentLocaleCodes,
  type ContentLocale,
} from './table';

/**
 * The locales THIS deployment translates into: the site-configuration opt-in
 * intersected with the built-in registry. Codes the registry does not know
 * are reported by site-configuration validation at save time; here they are
 * simply dropped so a stale stored value can never invent a pipeline.
 * Returns [] whenever translation is off — the subsystem's inert state.
 */
export async function enabledContentLocales(
  strapi: Core.Strapi,
): Promise<ContentLocale[]> {
  const configuration = await cachedSiteConfiguration(strapi);
  return translationLocaleCodes(configuration)
    .filter((code) => code !== DEFAULT_CONTENT_LOCALE)
    .map((code) => contentLocaleByCode(code))
    .filter((locale): locale is ContentLocale => Boolean(locale));
}

// Boot-primed sync mirror for hot paths that cannot await (the ISR outbox
// insert runs inside write transactions). Enabling/disabling translation
// already requires a restart (locale creation, dispatcher start), so a
// boot-time constant is the honest model, not a stale cache.
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
