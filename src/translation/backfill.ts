// One-time BULK BACKFILL: enqueue every default-locale entry of every
// localized type into the same outbox the incremental pipeline drains. The
// migration package is deliberately NOT used here — its raw SQL bypasses
// sanitization, validation and ISR, which is exactly what LLM output must
// not skip. Re-running is free: pending jobs coalesce, and hash-current
// entries whose complete persisted locale plan matches no-op before write.
import type { Core } from '@strapi/strapi';
import { estimateBackfillCost, type CostEstimate } from './cost';
import { translationConfigFromEnv } from './config';
import { collectTranslatableLeaves } from './field-map';
import { enabledContentLocales } from './locales/registry';
import { translationStore, wakeTranslationOutbox } from './outbox/runtime';
import { insertTranslationJobsBulk, type TranslationJobInsert } from './outbox/store';
import { TRANSLATION_BACKFILL_REASON } from './outbox/reasons';
import { UI_DICTIONARY_UID } from './ui-dictionary/constants';
import { enqueueUiDictionaryJobs } from './ui-dictionary/enqueue';
import { UiDictionaryStore } from './ui-dictionary/store';
import { inspectLocaleVersion, loadPopulatedEntry } from './writer';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { sourceContentHash } from './source-hash';
import { translationPromptFingerprint } from './prompts';
import type { ContentLocale } from './locales/resolve';
import { translationSourceIneligible } from './eligibility';

const PAGE_SIZE = 1_000;

/**
 * Wave order: relation targets before relation owners, catalog before the
 * single types whose components point into it — so by the time a page's
 * job runs, the documents its relations must resolve to usually exist.
 * (Stragglers are covered by the dispatcher's relation retries.)
 */
const WAVE_ORDER = [
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
  'api::coupon.coupon',
  'api::deal.deal',
  'api::job.job',
] as const;

export function localizedApiUids(strapi: Core.Strapi): string[] {
  const uids = Object.entries(strapi.contentTypes as Record<string, any>)
    .filter(
      ([uid, model]) =>
        uid.startsWith('api::') &&
        model?.pluginOptions?.i18n?.localized === true,
    )
    .map(([uid]) => uid);
  const waveIndex = (uid: string) => {
    const index = WAVE_ORDER.indexOf(uid as (typeof WAVE_ORDER)[number]);
    return index === -1 ? WAVE_ORDER.length : index;
  };
  return uids.sort(
    (a, b) => waveIndex(a) - waveIndex(b) || a.localeCompare(b),
  );
}

async function* defaultLocaleDocumentIds(
  strapi: Core.Strapi,
  uid: string,
): AsyncGenerator<string[]> {
  let lastId = 0;
  for (;;) {
    const rows: any[] = await strapi.db.query(uid as any).findMany({
      where: { locale: DEFAULT_CONTENT_LOCALE, id: { $gt: lastId } },
      select: ['id', 'documentId'],
      orderBy: { id: 'asc' },
      limit: PAGE_SIZE,
    } as any);
    if (!rows?.length) return;
    lastId = Number(rows[rows.length - 1].id);
    yield rows
      .map((row) => row?.documentId)
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
    if (rows.length < PAGE_SIZE) return;
  }
}

/** The dictionary rides along unless `uids` names types and leaves it out. */
function includesDictionary(uids?: readonly string[]): boolean {
  return !uids || uids.includes(UI_DICTIONARY_UID);
}

export type BackfillResult = {
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  skippedIneligible: number;
  providerCallsExpected: number;
  perUid: Record<string, number>;
  locales: string[];
};

export type BackfillMode = 'all' | 'repair';

export type BackfillProgress = {
  uidsTotal: number;
  uidsDone: number;
  currentUid: string | null;
  documentsScanned: number;
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  skippedIneligible: number;
};

type CandidateScan = {
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  skippedIneligible: number;
  providerChars: number[];
  perUid: Record<string, number>;
};

type ScanOptions = {
  mode: BackfillMode;
  force: boolean;
  reason: string;
  /**
   * Receives each page's job inputs as soon as the page is scanned. The
   * enqueue path commits them right away (bounded transactions, see
   * flushInputs); the estimate path passes nothing.
   */
  onPage?: (inputs: TranslationJobInsert[]) => Promise<number>;
  onProgress?: (progress: BackfillProgress) => void;
};

/**
 * Inserts per transaction. insertTranslationJobsBulk takes one advisory
 * transaction lock per event key, and every lock is held until commit.
 * Postgres's shared lock table holds roughly max_locks_per_transaction ×
 * max_connections entries (6,400 on stock settings), so enqueueing a whole
 * catalogue in one transaction fails with "out of shared memory" and enqueues
 * nothing. Committing per bounded chunk keeps the lock footprint small; the
 * outbox's pending-only unique index makes a partial run safely resumable.
 */
const ENQUEUE_CHUNK = 500;

async function flushInputs(
  strapi: Core.Strapi,
  inputs: readonly TranslationJobInsert[],
): Promise<number> {
  let enqueued = 0;
  for (let start = 0; start < inputs.length; start += ENQUEUE_CHUNK) {
    const chunk = inputs.slice(start, start + ENQUEUE_CHUNK);
    await strapi.db.transaction(async ({ trx }: any) => {
      await insertTranslationJobsBulk(trx, chunk);
    });
    enqueued += chunk.length;
  }
  return enqueued;
}

function completeMemory(
  translations: Record<string, string> | null,
  leaves: ReturnType<typeof collectTranslatableLeaves>,
): translations is Record<string, string> {
  return Boolean(
    translations &&
      leaves.every(
        (leaf) =>
          typeof translations[leaf.path] === 'string' &&
          translations[leaf.path].trim().length > 0,
      ),
  );
}

async function scanContentCandidates(
  strapi: Core.Strapi,
  uids: readonly string[],
  locales: readonly ContentLocale[],
  options: ScanOptions,
): Promise<CandidateScan> {
  const scan: CandidateScan = {
    selected: 0,
    enqueued: 0,
    skippedCurrent: 0,
    skippedIneligible: 0,
    providerChars: [],
    perUid: {},
  };
  const progress: BackfillProgress = {
    uidsTotal: uids.length,
    uidsDone: 0,
    currentUid: null,
    documentsScanned: 0,
    selected: 0,
    enqueued: 0,
    skippedCurrent: 0,
    skippedIneligible: 0,
  };
  const report = () => {
    progress.selected = scan.selected;
    progress.enqueued = scan.enqueued;
    progress.skippedCurrent = scan.skippedCurrent;
    progress.skippedIneligible = scan.skippedIneligible;
    options.onProgress?.({ ...progress });
  };
  if (uids.length === 0 || locales.length === 0) return scan;
  const store = translationStore(strapi);
  for (const uid of uids) {
    scan.perUid[uid] = 0;
    progress.currentUid = uid;
    report();
    for await (const page of defaultLocaleDocumentIds(strapi, uid)) {
      const inputs: TranslationJobInsert[] = [];
      for (const documentId of page) {
        const source = await loadPopulatedEntry(
          strapi,
          uid,
          documentId,
          DEFAULT_CONTENT_LOCALE,
        );
        progress.documentsScanned += 1;
        if (!source) continue;
        if (translationSourceIneligible(uid, source)) {
          scan.skippedIneligible += locales.length;
          report();
          continue;
        }
        const leaves = collectTranslatableLeaves(strapi, uid, source);
        for (const locale of locales) {
          const targetLocale = locale.code;
          const hash = sourceContentHash(
            leaves,
            translationPromptFingerprint(strapi, locale),
          );
          const [state, latestJob] = await Promise.all([
            store.readState(uid, documentId, targetLocale),
            store.activeJob(uid, documentId, targetLocale),
          ]);
          const memoryComplete = completeMemory(state?.translations ?? null, leaves);
          const textCurrent =
            !options.force && state?.sourceHash === hash && memoryComplete;
          const latestNeedsRepair =
            latestJob?.status === 'failed' || latestJob?.status === 'blocked';
          // Only repair mode acts on "current": the full plan comparison is
          // the expensive part of the scan (a second deep populate plus
          // existence batches), so mode "all" does not pay for it.
          let current = false;
          if (options.mode === 'repair' && textCurrent && !latestNeedsRepair) {
            const inspection = await inspectLocaleVersion(
              strapi,
              uid,
              documentId,
              targetLocale,
              source,
              new Map(Object.entries(state!.translations!)),
            );
            current = inspection.current && inspection.skippedRelations.length === 0;
          }
          if (options.mode === 'repair' && current) {
            scan.skippedCurrent += 1;
            continue;
          }
          const providerRequired = !textCurrent && leaves.length > 0;
          inputs.push({
            uid,
            documentId,
            targetLocale,
            kind: providerRequired ? 'translate' : 'relation-sync',
            force: options.force,
            reason: options.reason,
          });
          scan.selected += 1;
          scan.perUid[uid] += 1;
          if (providerRequired) {
            scan.providerChars.push(
              leaves.reduce((sum, leaf) => sum + leaf.value.length, 0),
            );
          }
        }
      }
      if (inputs.length > 0 && options.onPage) {
        scan.enqueued += await options.onPage(inputs);
      }
      report();
    }
    progress.uidsDone += 1;
    report();
  }
  progress.currentUid = null;
  report();
  return scan;
}

export type BackfillOptions = {
  uids?: string[];
  locales?: string[];
  force?: boolean;
  reason?: string;
  mode?: BackfillMode;
  onProgress?: (progress: BackfillProgress) => void;
};

export async function enqueueTranslationBackfill(
  strapi: Core.Strapi,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const reason = options.reason ?? TRANSLATION_BACKFILL_REASON;
  const mode = options.mode ?? 'all';
  const enabled = await enabledContentLocales(strapi);
  const targetLocales = enabled.filter(
    (locale) => !options.locales || options.locales.includes(locale.code),
  );
  const locales = targetLocales.map((locale) => locale.code);
  const uids = localizedApiUids(strapi).filter(
    (uid) => !options.uids || options.uids.includes(uid),
  );
  let selected = 0;
  let skippedCurrent = 0;
  let skippedIneligible = 0;
  let providerCallsExpected = 0;
  const dictionaryProviderChars: number[] = [];
  let perUid: Record<string, number> = {};
  let enqueued = 0;
  if (locales.length === 0) {
    return { selected, enqueued, skippedCurrent, skippedIneligible, providerCallsExpected, perUid, locales };
  }

  const scan = await scanContentCandidates(strapi, uids, targetLocales, {
    mode,
    force: options.force === true,
    reason,
    onPage: (inputs) => flushInputs(strapi, inputs),
    onProgress: options.onProgress,
  });
  selected += scan.selected;
  skippedCurrent += scan.skippedCurrent;
  skippedIneligible += scan.skippedIneligible;
  perUid = scan.perUid;
  enqueued += scan.enqueued;
  // After the content waves: the storefront's UI text, one job per locale
  // (inert unless the translation runtime is up — same as every enqueue).
  if (includesDictionary(options.uids)) {
    const dictionaryStore = new UiDictionaryStore(strapi);
    const dictionaryLocales: string[] = [];
    for (const locale of locales) {
      const leaves = await dictionaryStore.pendingLeaves(
        locale,
        options.force === true,
      );
      if (mode === 'all' || leaves.length > 0) {
        dictionaryLocales.push(locale);
        selected += 1;
        const chars = leaves.reduce((sum, leaf) => sum + leaf.text.length, 0);
        if (chars > 0) dictionaryProviderChars.push(chars);
      } else {
        skippedCurrent += 1;
      }
    }
    const dictionary = await enqueueUiDictionaryJobs(strapi, {
      locales: dictionaryLocales,
      force: options.force === true,
      reason,
    });
    perUid[UI_DICTIONARY_UID] = dictionary.enqueued.length;
    enqueued += dictionary.enqueued.length;
  }
  providerCallsExpected = estimateBackfillCost(
    translationConfigFromEnv() ?? {
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      chunkChars: 12_000,
    },
    [...scan.providerChars, ...dictionaryProviderChars],
    0,
    2,
  ).estimatedCalls;
  wakeTranslationOutbox();
  return {
    selected,
    enqueued,
    skippedCurrent,
    skippedIneligible,
    providerCallsExpected,
    perUid,
    locales,
  };
}

/**
 * Dry-run cost estimate: walks every entry's translatable leaves (no LLM
 * calls) and prices the batch with the configured rates. Slow-ish by nature
 * (it populates every document once) — a one-off super-admin read.
 */
export async function estimateTranslationBackfill(
  strapi: Core.Strapi,
  options: Omit<BackfillOptions, 'reason'> = {},
): Promise<CostEstimate & BackfillResult> {
  const config = translationConfigFromEnv();
  const targetLocales = (await enabledContentLocales(strapi)).filter(
    (locale) => !options.locales || options.locales.includes(locale.code),
  );
  const locales = targetLocales.map((locale) => locale.code);
  const uids = localizedApiUids(strapi).filter(
    (uid) => !options.uids || options.uids.includes(uid),
  );
  const scan = await scanContentCandidates(strapi, uids, targetLocales, {
    mode: options.mode ?? 'all',
    force: options.force === true,
    reason: TRANSLATION_BACKFILL_REASON,
    onProgress: options.onProgress,
  });
  const perEntryChars = [...scan.providerChars];
  const perUid = { ...scan.perUid };
  let selected = scan.selected;
  let skippedCurrent = scan.skippedCurrent;
  // The system prompt (brief + contract) rides along once per call.
  const promptOverheadChars = 6_000;
  const localeEntries = [...perEntryChars];
  // The dictionary is already per locale: one line per locale holding the
  // characters of every key still missing or stale there. Nothing pending
  // (or translation off → no locales) adds no line at all.
  if (includesDictionary(options.uids) && locales.length > 0) {
    const dictionary = new UiDictionaryStore(strapi);
    perUid[UI_DICTIONARY_UID] = 0;
    for (const locale of locales) {
      const leaves = await dictionary.pendingLeaves(locale, options.force === true);
      const chars = leaves.reduce((sum, leaf) => sum + leaf.text.length, 0);
      const include = (options.mode ?? 'all') === 'all' || leaves.length > 0;
      if (include) {
        perUid[UI_DICTIONARY_UID] += 1;
        selected += 1;
        if (chars > 0) {
          localeEntries.push(chars);
        }
      } else {
        skippedCurrent += 1;
      }
    }
  }
  const estimate = estimateBackfillCost(
    config ?? { inputCostPerMTok: 0, outputCostPerMTok: 0, chunkChars: 12_000 },
    localeEntries,
    promptOverheadChars,
    2,
  );
  return {
    ...estimate,
    selected,
    enqueued: 0,
    skippedCurrent,
    skippedIneligible: scan.skippedIneligible,
    providerCallsExpected: estimate.estimatedCalls,
    perUid,
    locales,
  };
}
