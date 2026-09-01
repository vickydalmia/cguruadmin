// The DICTIONARY TRANSLATION JOB: the dispatcher's branch for the synthetic
// `ui-dictionary:catalogue:<locale>` job. The dictionary table is its own
// memory (pending = missing or stale rows), so there is no translation_state
// row here. `translateEntryLeaves` is all-or-nothing per call, which is why
// the work is cut into key-sorted groups and every group is persisted the
// moment it comes back: a later group's failure defers only what is still
// missing, never what was already delivered.
import type { Core } from '@strapi/strapi';
import type { TranslationConfig } from '../config';
import { usdForTokens } from '../cost';
import { TranslationError } from '../errors';
import type { TranslatableLeaf } from '../field-map';
import type { ContentLocale } from '../locales/resolve';
import type { JobOutcome } from '../outbox/dispatcher';
import type { TranslationJob, TranslationOutboxStore } from '../outbox/store';
import type { TranslationProvider } from '../provider/types';
import { translateEntryLeaves } from '../translate-entry';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import { UI_DICTIONARY_GROUP_SIZE, UI_DICTIONARY_UID } from './constants';
import { requestUiDictionarySweep } from './isr';
import { UiDictionaryStore } from './store';
import type { AiTranslationWrite, UiDictionaryPendingLeaf } from './types';

export type UiDictionaryJobDeps = {
  strapi: Core.Strapi;
  provider: TranslationProvider;
  config: TranslationConfig;
  /** The outbox store — only its provider-attempt ledger hooks are used. */
  store: Pick<TranslationOutboxStore, 'providerAttemptHooks'>;
  job: TranslationJob;
  locale: ContentLocale;
  assertLease: () => Promise<void>;
  /** Test seam; production reads and writes the dictionary tables. */
  dictionary?: Pick<UiDictionaryStore, 'pendingLeaves' | 'writeAiTranslations'>;
};

export type UiDictionaryJobUsage = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type UiDictionaryJobResult = {
  outcome: JobOutcome;
  usage: UiDictionaryJobUsage;
};

const MAX_REASON_CHARS = 1_000;

/**
 * Batch guidance for the writer/editor. Lives in the USER message on
 * purpose: the system prompts are fingerprinted into every content hash,
 * and a wording tweak here must never re-translate the whole site.
 */
export function uiDictionaryBrief(locale: ContentLocale): string {
  return [
    'These strings are the storefront user interface of a coupons and deals website: ' +
      'labels, buttons, menu items, aria-labels, tooltips, empty states and status messages.',
    `Write natural ${locale.name} UI copy of similar brevity. Keep imperative verbs short — ` +
      `a button label stays as short as ${locale.name} allows.`,
    'Keep every {placeholder} exactly as written (same name, same braces) and place it where a ' +
      `${locale.name} reader expects the value.`,
    'No trailing punctuation unless the English source ends with it; keep an ellipsis, colon ' +
      'or question mark only where the source has one.',
    `Follow ${locale.name} capitalisation and spacing conventions for interface text rather ` +
      'than copying English capitalisation.',
    'A field note naming a plural form tells you which count category (one, few, many, other, …) ' +
      'that string is shown for; write the wording that is grammatical for such counts.',
  ].join('\n');
}

function toLeaf(leaf: UiDictionaryPendingLeaf): TranslatableLeaf {
  return {
    path: leaf.key,
    kind: 'plain',
    value: leaf.text,
    ...(leaf.maxLength ? { maxLength: leaf.maxLength } : {}),
    ...(leaf.note ? { note: leaf.note } : {}),
  };
}

function groupsOf<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/**
 * Errors that must end the job now rather than move on to the next group:
 * a request the provider will reject again, the day's budget, or a lease
 * another worker may already hold.
 */
function stopsTheJob(error: unknown): boolean {
  return (
    error instanceof TranslationError &&
    (!error.retryable ||
      error.code === 'TRANSLATION_BUDGET_EXCEEDED' ||
      error.code === 'TRANSLATION_LEASE_LOST')
  );
}

function keyRange(group: readonly UiDictionaryPendingLeaf[]): string {
  const first = group[0].key;
  const last = group[group.length - 1].key;
  return first === last ? first : `${first}…${last}`;
}

function deferredReason(
  failures: readonly { range: string; error: string }[],
  groups: number,
): string {
  const detail = failures.map((failure) => `${failure.range} (${failure.error})`).join('; ');
  const reason = `${failures.length}/${groups} dictionary group(s) failed: ${detail}`;
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}

export async function processUiDictionaryJob(deps: UiDictionaryJobDeps): Promise<UiDictionaryJobResult> {
  const { strapi, provider, config, store, job, locale, assertLease } = deps;
  const dictionary = deps.dictionary ?? new UiDictionaryStore(strapi);
  let tokensIn = 0;
  let tokensOut = 0;
  const usage = (): UiDictionaryJobUsage => ({
    tokensIn,
    tokensOut,
    costUsd: Math.round(usdForTokens(config, tokensIn, tokensOut) * 1_000_000) / 1_000_000,
  });

  const pending = (await dictionary.pendingLeaves(job.targetLocale, job.force)).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  if (pending.length === 0) {
    return { outcome: { state: 'skipped', reason: 'dictionary current' }, usage: usage() };
  }

  const groups = groupsOf(pending, UI_DICTIONARY_GROUP_SIZE);
  const context = {
    uid: UI_DICTIONARY_UID,
    contentType: 'Storefront UI text',
    sourceLocale: DEFAULT_CONTENT_LOCALE,
    targetLocale: locale.code,
    brief: uiDictionaryBrief(locale),
  };
  const failures: { range: string; error: string }[] = [];
  let written = 0;
  let guarded = 0;
  let staleDropped = 0;

  try {
    for (const group of groups) {
      await assertLease();
      try {
        const result = await translateEntryLeaves(
          strapi,
          provider,
          config,
          locale,
          group.map(toLeaf),
          context,
          (stage) => store.providerAttemptHooks(job, config, provider.name, stage),
        );
        tokensIn += result.inputTokens;
        tokensOut += result.outputTokens;
        // The two AI passes can outlast the lease; a worker that lost it
        // must not persist (the new owner re-translates this group).
        await assertLease();
        const rows: AiTranslationWrite[] = group.map((leaf) => ({
          key: leaf.key,
          text: result.translations.get(leaf.key) as string,
          sourceHash: leaf.sourceHash,
        }));
        const write = await dictionary.writeAiTranslations(locale.code, rows);
        written += write.written;
        guarded += write.guarded;
        staleDropped += write.staleDropped.length;
      } catch (cause) {
        if (stopsTheJob(cause)) throw cause;
        failures.push({
          range: keyRange(group),
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  } finally {
    // Delivered groups are live in the table already; the storefront must
    // see them even when a later group stopped the job (budget, lease).
    if (written > 0) await requestUiDictionarySweep(strapi);
  }

  if (failures.length > 0) {
    return {
      outcome: { state: 'deferred', reason: deferredReason(failures, groups.length), delayMs: 0 },
      usage: usage(),
    };
  }
  const notes = [`${written} key(s)`, `${guarded} guarded`];
  if (staleDropped > 0) notes.push(`${staleDropped} dropped as stale`);
  return { outcome: { state: 'delivered', notes: notes.join(', ') }, usage: usage() };
}
