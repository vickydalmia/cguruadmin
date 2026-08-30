// Per-entry translation STATUS for the admin panel: one verdict per enabled
// target locale, derived from the state table, the live outbox, and a fresh
// hash of the default-locale entry.
import type { Core } from '@strapi/strapi';
import { collectTranslatableLeaves } from './field-map';
import { enabledContentLocales } from './locales/registry';
import { translationStore } from './outbox/runtime';
import { sourceContentHash } from './source-hash';
import { translationPromptFingerprint } from './prompts';
import { loadPopulatedEntry } from './writer';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';

export type LocaleTranslationStatus = {
  locale: string;
  localeName: string;
  state:
    | 'missing'
    | 'synced'
    | 'stale'
    | 'in-progress'
    | 'failed';
  needsReview: boolean;
  reviewNotes: string | null;
  translatedAt: string | null;
  lastError: string | null;
};

export async function entryTranslationStatus(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
): Promise<{ enabled: boolean; locales: LocaleTranslationStatus[] }> {
  const locales = await enabledContentLocales(strapi);
  if (locales.length === 0) return { enabled: false, locales: [] };

  const source = await loadPopulatedEntry(
    strapi,
    uid,
    documentId,
    DEFAULT_CONTENT_LOCALE,
  );
  const store = translationStore(strapi);

  const results = await Promise.all(
    locales.map(async (locale): Promise<LocaleTranslationStatus> => {
      const currentHash = source
        ? sourceContentHash(
            collectTranslatableLeaves(strapi, uid, source),
            translationPromptFingerprint(strapi, locale),
          )
        : null;
      const [state, job] = await Promise.all([
        store.readState(uid, documentId, locale.code),
        store.activeJob(uid, documentId, locale.code),
      ]);
      let verdict: LocaleTranslationStatus['state'];
      if (job && (job.status === 'pending' || job.status === 'processing')) {
        verdict = 'in-progress';
      } else if (job?.status === 'failed') {
        verdict = 'failed';
      } else if (!state) {
        verdict = 'missing';
      } else if (currentHash && state.sourceHash === currentHash) {
        verdict = 'synced';
      } else {
        verdict = 'stale';
      }
      return {
        locale: locale.code,
        localeName: locale.name,
        state: verdict,
        needsReview: state?.needsReview ?? false,
        reviewNotes: state?.reviewNotes ?? null,
        translatedAt: state?.translatedAt?.toISOString() ?? null,
        lastError: job?.lastError ?? state?.lastError ?? null,
      };
    }),
  );
  return { enabled: true, locales: results };
}
