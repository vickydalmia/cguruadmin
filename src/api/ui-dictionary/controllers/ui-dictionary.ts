// Content-API surface of the UI-text dictionary (src/api/ui-dictionary has
// routes and a controller but no content type — like isr-status):
// the storefront's public read and its deployment catalogue sync.
import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { enabledContentLocaleCodesSync } from '../../../translation/locales/registry';
import { logTranslation } from '../../../translation/outbox/log';
import { parseCatalogueBody } from '../../../translation/ui-dictionary/catalogue-schema';
import { enqueueUiDictionaryJobs } from '../../../translation/ui-dictionary/enqueue';
import { requestUiDictionarySweep } from '../../../translation/ui-dictionary/isr';
import { UiDictionaryStore } from '../../../translation/ui-dictionary/store';

/**
 * Unknown, disabled or absent locales read as English. This must match the
 * cache middleware's keying rule (src/middlewares/cache.ts): it folds
 * `locale` into the key only for enabled codes, so anything else shares the
 * English entry — and therefore must also BE the English body.
 */
export function normaliseDictionaryLocale(
  raw: unknown,
  enabled: readonly string[],
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' &&
    value !== DEFAULT_CONTENT_LOCALE &&
    enabled.includes(value)
    ? value
    : DEFAULT_CONTENT_LOCALE;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async find(ctx: any) {
    const locale = normaliseDictionaryLocale(
      ctx.query?.locale,
      enabledContentLocaleCodesSync(),
    );
    const data = await new UiDictionaryStore(strapi).publicDictionary(locale);
    ctx.set('Cache-Control', 'public, max-age=60');
    ctx.body = { data };
  },

  async syncCatalogue(ctx: any) {
    const parsed = parseCatalogueBody(ctx.request?.body);
    if (parsed.ok === false) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid catalogue push', problems: parsed.problems };
      return;
    }
    const result = await new UiDictionaryStore(strapi).syncCatalogue(parsed.value);
    if (!result.unchanged) {
      // Removals alone need no translation; any change re-renders the site
      // (a removed key's override disappears from the served messages).
      const jobs =
        result.touchedKeys.length > 0
          ? await enqueueUiDictionaryJobs(strapi, { reason: 'catalogue sync' })
          : { enqueued: [] as string[] };
      const sweep = await requestUiDictionarySweep(strapi);
      logTranslation(strapi, 'info', 'ui-dictionary.catalogue_synced', {
        version: result.version,
        added: result.added,
        changed: result.changed,
        removed: result.removed,
        touched: result.touchedKeys.length,
        jobs: jobs.enqueued,
        sweep: sweep.skipped ? 'coalesced' : 'enqueued',
      });
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.body = {
      data: {
        unchanged: result.unchanged,
        added: result.added,
        changed: result.changed,
        removed: result.removed,
        version: result.version,
      },
    };
  },
});
