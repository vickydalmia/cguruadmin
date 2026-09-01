// Enqueue the dictionary translation job — one outbox row per enabled
// locale under the synthetic `ui-dictionary:catalogue:<locale>` identity, so
// the existing dispatcher/lease/backoff/budget machinery drives it (B2 adds
// the dispatcher branch). Inert on deployments without translation.
import type { Core } from '@strapi/strapi';
import { enabledContentLocaleCodesSync } from '../locales/registry';
import {
  enqueueStandaloneTranslationJob,
  translationRuntimeActive,
} from '../outbox/runtime';
import { UI_DICTIONARY_DOCUMENT_ID, UI_DICTIONARY_UID } from './constants';

export type EnqueueUiDictionaryJobsInput = {
  /** Subset of the enabled locales; default all enabled. Unknown codes are dropped. */
  locales?: readonly string[];
  /** Re-translate current AI rows too (manual rows are never touched). */
  force?: boolean;
  reason: string;
};

export async function enqueueUiDictionaryJobs(
  strapi: Core.Strapi,
  input: EnqueueUiDictionaryJobsInput,
): Promise<{ enqueued: string[] }> {
  if (!(await translationRuntimeActive(strapi))) return { enqueued: [] };
  const enabled = enabledContentLocaleCodesSync();
  const targets = input.locales
    ? [...new Set(input.locales)].filter((code) => enabled.includes(code))
    : [...enabled];
  for (const targetLocale of targets) {
    await enqueueStandaloneTranslationJob(strapi, {
      uid: UI_DICTIONARY_UID,
      documentId: UI_DICTIONARY_DOCUMENT_ID,
      targetLocale,
      kind: 'translate',
      force: input.force === true,
      reason: input.reason,
    });
  }
  return { enqueued: targets };
}
