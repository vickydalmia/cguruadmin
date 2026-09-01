// HOT-APPLY of a Country Setup save for the translation subsystem in THIS
// process: the same sequence src/index.ts runs at bootstrap (create the
// opted-in locale rows, re-prime the sync locale mirror the ISR path
// expansion reads, then start the job dispatcher), so an admin who picks a
// language does not have to restart the CMS they are talking to. Other CMS
// containers still pick the change up at their next restart — the mirror
// and the dispatcher are per process.
//
// Never fails the admin's save: every failure is logged loudly and swallowed.
import type { Core } from '@strapi/strapi';
import { ensureContentLocales } from '../../../translation/ensure-locales';
import { primeEnabledContentLocales } from '../../../translation/locales/registry';
import {
  translationConfigFromEnv,
  translationConfigProblem,
} from '../../../translation/config';
import { logTranslation } from '../../../translation/outbox/log';
import {
  startTranslationOutbox,
  translationOutboxRunning,
} from '../../../translation/outbox/runtime';
import { invalidateCachedSiteConfiguration } from './cached-configuration';

export type TranslationHotApplyOutcome =
  | {
      ok: true;
      /** `not-started`: env parses but the site has no target language. */
      outbox: 'already-running' | 'started' | 'not-started' | 'env-missing';
    }
  | { ok: false; error: string };

export async function applyTranslationSettings(
  strapi: Core.Strapi,
): Promise<TranslationHotApplyOutcome> {
  // The memo feeds enabledContentLocales(); without this the steps below
  // would bootstrap the PREVIOUS language list for up to one TTL.
  invalidateCachedSiteConfiguration();
  try {
    await ensureContentLocales(strapi);
    await primeEnabledContentLocales(strapi);
  } catch (err: any) {
    const error = String(err?.message ?? err);
    logTranslation(strapi, 'error', 'translation.hot_apply_failed', {
      step: 'content-locales',
      error,
      hint: 'restart the CMS to retry the locale bootstrap',
    });
    return { ok: false, error };
  }

  if (translationOutboxRunning()) {
    logTranslation(strapi, 'info', 'translation.hot_apply', { outbox: 'already-running' });
    return { ok: true, outbox: 'already-running' };
  }
  if (!translationConfigFromEnv()) {
    // Never start a half-configured paid pipeline. startTranslationOutbox
    // would refuse too, but reporting the reason here keeps the save log
    // self-explanatory (India/USA saves with no env land here silently at
    // info level; the loud misconfigured alert stays a boot-time concern).
    logTranslation(strapi, 'info', 'translation.hot_apply', {
      outbox: 'env-missing',
      reason: translationConfigProblem(),
    });
    return { ok: true, outbox: 'env-missing' };
  }
  try {
    await startTranslationOutbox(strapi);
    const outbox = translationOutboxRunning() ? 'started' : 'not-started';
    logTranslation(strapi, 'info', 'translation.hot_apply', { outbox });
    return { ok: true, outbox };
  } catch (err: any) {
    const error = String(err?.message ?? err);
    logTranslation(strapi, 'error', 'translation.hot_apply_failed', {
      step: 'outbox-start',
      error,
      hint: 'restart the CMS to start the translation dispatcher',
    });
    return { ok: false, error };
  }
}
