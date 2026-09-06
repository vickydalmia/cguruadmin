import type { Core } from '@strapi/strapi';
import { enabledContentLocales } from './locales/registry';
import { logTranslation } from './outbox/log';

/**
 * Idempotent bootstrap step: every content locale the site opted into
 * exists as a Strapi locale row, so the Content Manager shows its locale
 * switcher and the documents API accepts the code. A no-op on deployments
 * with translation off — their CM stays visually single-locale.
 */
export async function ensureContentLocales(strapi: Core.Strapi): Promise<void> {
  const locales = await enabledContentLocales(strapi);
  if (locales.length === 0) return;
  const service = strapi.plugin('i18n').service('locales');
  for (const locale of locales) {
    const existing = await service.findByCode(locale.code);
    if (existing) continue;
    await service.create({
      code: locale.code,
      name: `${locale.name} (${locale.code})`,
    });
    logTranslation(strapi, 'info', 'translation.locale_created', {
      code: locale.code,
      name: locale.name,
    });
  }
}
