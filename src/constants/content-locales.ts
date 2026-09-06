/**
 * Content-locale constants shared by every read path that must stay
 * locale-deterministic once Strapi i18n is enabled on the content types.
 *
 * The DEFAULT content locale is the bare `en` code on every deployment
 * (India, USA, UAE alike) — it is a different axis from
 * `site-configuration.locale` (`en-IN` / `en-US` / `en-AE`), which only
 * drives currency/number/date formatting. Strapi's own default-locale
 * setting is left at its built-in `en`; nothing in this repo overrides
 * STRAPI_PLUGIN_I18N_INIT_LOCALE_CODE, and the translation subsystem
 * treats the default locale as the single source of truth that other
 * locales are generated from.
 *
 * Raw SQL and `strapi.db.query` reads get NO automatic locale filter from
 * Strapi (only the documents API defaults to the default locale), so any
 * such read of a localized table must filter on this constant — otherwise
 * it silently returns one row per locale.
 */
export const DEFAULT_CONTENT_LOCALE = 'en';
