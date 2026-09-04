// One-time BULK BACKFILL: enqueue every default-locale entry of every
// localized type into the same outbox the incremental pipeline drains. The
// migration package is deliberately NOT used here — its raw SQL bypasses
// sanitization, validation and ISR, which is exactly what LLM output must
// not skip. Re-running is free: pending jobs coalesce, and hash-current
// entries whose complete persisted locale plan matches no-op before write.
import type { Core } from '@strapi/strapi';
import { estimateBackfillCost, type CostEstimate } from './cost';
import { translationConfigFromEnv } from './config';
import {
  buildLocalizedData,
  collectRelationTargets,
  collectTranslatableLeaves,
  resolveRelationExistence,
  type RelationTarget,
} from './field-map';
import { enabledContentLocales } from './locales/registry';
import { translationStore, wakeTranslationOutbox } from './outbox/runtime';
import {
  insertTranslationJobsBulk,
  translationSnapshotKey,
  type TranslationJobInsert,
} from './outbox/store';
import { TRANSLATION_BACKFILL_REASON } from './outbox/reasons';
import { UI_DICTIONARY_UID } from './ui-dictionary/constants';
import { enqueueUiDictionaryJobs } from './ui-dictionary/enqueue';
import { UiDictionaryStore } from './ui-dictionary/store';
import {
  inspectPopulatedLocaleVersion,
  loadPopulatedEntries,
  localizedPlanHash,
} from './writer';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { sourceContentHash } from './source-hash';
import { translationPromptFingerprint } from './prompts';
import { unicodeScriptPattern, type ContentLocale } from './locales/resolve';
import { translationSourceIneligible } from './eligibility';
import { translationPopulate } from './populate';
import { validateTranslatedBatch } from './validate';

const PAGE_SIZE = 50;

/**
 * Structural singletons are few but their nested component trees drive every
 * page (menu, footer, homepage, global and CMS static pages). A saved plan hash
 * proves what the translator last intended to write; it cannot prove that a
 * later editor/import did not remove a component or relation. Repair scans
 * therefore compare these rows exactly. High-volume catalogue types retain
 * the plan-hash fast path that keeps a full sweep affordable.
 */
function requiresExactPersistedPlanInspection(
  strapi: Core.Strapi,
  uid: string,
): boolean {
  return (strapi.contentTypes as Record<string, any>)?.[uid]?.kind === 'singleType';
}

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

type SourcePage = { entries: any[]; lastId: number };

async function* defaultLocaleEntries(
  strapi: Core.Strapi,
  uid: string,
  afterId = 0,
): AsyncGenerator<SourcePage> {
  let lastId = afterId;
  for (;;) {
    const rows: any[] = await strapi.db.query(uid as any).findMany({
      where: { locale: DEFAULT_CONTENT_LOCALE, id: { $gt: lastId } },
      orderBy: { id: 'asc' },
      limit: PAGE_SIZE,
      populate: translationPopulate(strapi, uid),
    } as any);
    if (!rows?.length) return;
    lastId = Number(rows[rows.length - 1].id);
    yield { entries: rows, lastId };
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

export type CandidateScan = {
  selected: number;
  enqueued: number;
  skippedCurrent: number;
  skippedIneligible: number;
  providerChars: number[];
  perUid: Record<string, number>;
};

export type BackfillCheckpoint = {
  uidIndex: number;
  lastSourceId: number;
  documentsScanned: number;
  scan: CandidateScan;
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
  onProgress?: (progress: BackfillProgress) => void | Promise<void>;
  onCheckpoint?: (
    progress: BackfillProgress,
    checkpoint: BackfillCheckpoint,
  ) => Promise<void>;
  checkpoint?: BackfillCheckpoint | null;
  persistPlanHashes?: boolean;
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
  locale: ContentLocale,
): translations is Record<string, string> {
  return Boolean(
    translations &&
      leaves.every(
        (leaf) =>
          typeof translations[leaf.path] === 'string' &&
          translations[leaf.path].trim().length > 0,
      ) &&
      validateTranslatedBatch(
        leaves,
        translations,
        unicodeScriptPattern(locale.script),
      ).length === 0,
  );
}

function cloneScan(scan: CandidateScan): CandidateScan {
  return {
    ...scan,
    providerChars: [...scan.providerChars],
    perUid: { ...scan.perUid },
  };
}

function maxDocumentsPerSecond(): number {
  const fallback = process.env.NODE_ENV === 'test' ? 0 : 20;
  const parsed = Number.parseInt(
    process.env.TRANSLATION_BACKFILL_MAX_DOCS_PER_SECOND ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function throttlePage(startedAt: number, documents: number): Promise<void> {
  const maximum = maxDocumentsPerSecond();
  if (maximum <= 0 || documents <= 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }
  const remaining = Math.ceil((documents / maximum) * 1_000) -
    (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  } else {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function mergeRelationTargets(
  strapi: Core.Strapi,
  uid: string,
  entries: readonly any[],
): RelationTarget[] {
  const byUid = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const target of collectRelationTargets(strapi, uid, entry)) {
      const ids = byUid.get(target.targetUid) ?? new Set<string>();
      for (const documentId of target.documentIds) ids.add(documentId);
      byUid.set(target.targetUid, ids);
    }
  }
  return [...byUid.entries()].map(([targetUid, documentIds]) => ({
    targetUid,
    documentIds: [...documentIds],
  }));
}

async function scanContentCandidates(
  strapi: Core.Strapi,
  uids: readonly string[],
  locales: readonly ContentLocale[],
  options: ScanOptions,
): Promise<CandidateScan> {
  const initial = options.checkpoint;
  const scan: CandidateScan = initial
    ? cloneScan(initial.scan)
    : {
        selected: 0,
        enqueued: 0,
        skippedCurrent: 0,
        skippedIneligible: 0,
        providerChars: [],
        perUid: {},
      };
  const progress: BackfillProgress = {
    uidsTotal: uids.length,
    uidsDone: Math.min(initial?.uidIndex ?? 0, uids.length),
    currentUid: null,
    documentsScanned: initial?.documentsScanned ?? 0,
    selected: scan.selected,
    enqueued: scan.enqueued,
    skippedCurrent: scan.skippedCurrent,
    skippedIneligible: scan.skippedIneligible,
  };
  const report = async (checkpoint?: BackfillCheckpoint) => {
    progress.selected = scan.selected;
    progress.enqueued = scan.enqueued;
    progress.skippedCurrent = scan.skippedCurrent;
    progress.skippedIneligible = scan.skippedIneligible;
    await options.onProgress?.({ ...progress });
    if (checkpoint) {
      await options.onCheckpoint?.(
        { ...progress },
        { ...checkpoint, scan: cloneScan(checkpoint.scan) },
      );
    }
  };
  if (uids.length === 0 || locales.length === 0) return scan;
  const store = translationStore(strapi);
  const localeCodes = locales.map((locale) => locale.code);

  for (
    let uidIndex = Math.min(initial?.uidIndex ?? 0, uids.length);
    uidIndex < uids.length;
    uidIndex += 1
  ) {
    const uid = uids[uidIndex];
    const inspectPersistedPlan = requiresExactPersistedPlanInspection(
      strapi,
      uid,
    );
    scan.perUid[uid] ??= 0;
    progress.currentUid = uid;
    progress.uidsDone = uidIndex;
    const firstSourceId = uidIndex === initial?.uidIndex
      ? initial.lastSourceId
      : 0;
    await report({
      uidIndex,
      lastSourceId: firstSourceId,
      documentsScanned: progress.documentsScanned,
      scan,
    });

    for await (const page of defaultLocaleEntries(strapi, uid, firstSourceId)) {
      const pageStartedAt = Date.now();
      const inputs: TranslationJobInsert[] = [];
      const populatedSources = page.entries.filter(
        (entry) => typeof entry?.documentId === 'string' && entry.documentId,
      );
      const sources = populatedSources.filter((source) => {
        if (!translationSourceIneligible(uid, source)) return true;
        scan.skippedIneligible += locales.length;
        return false;
      });
      const snapshot = await store.readBackfillSnapshot(
        uid,
        sources.map((entry) => String(entry.documentId)),
        localeCodes,
      );
      const inspections = new Map<string, Array<{
        source: any;
        documentId: string;
        leaves: ReturnType<typeof collectTranslatableLeaves>;
        translations: Record<string, string>;
        state: { publishedPlanHash?: string | null };
      }>>();

      const select = (
        documentId: string,
        targetLocale: string,
        providerRequired: boolean,
        characters: number,
      ) => {
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
        if (providerRequired) scan.providerChars.push(characters);
      };

      for (const source of sources) {
        const documentId = String(source.documentId);
        const leaves = collectTranslatableLeaves(strapi, uid, source);
        const characters = leaves.reduce((sum, leaf) => sum + leaf.value.length, 0);
        for (const locale of locales) {
          const targetLocale = locale.code;
          const hash = sourceContentHash(
            leaves,
            translationPromptFingerprint(strapi, locale),
          );
          const key = translationSnapshotKey(documentId, targetLocale);
          const state = snapshot.states.get(key) ?? null;
          const latestJob = snapshot.jobs.get(key) ?? null;
          const memoryComplete = completeMemory(
            state?.translations ?? null,
            leaves,
            locale,
          );
          const textCurrent =
            !options.force && state?.sourceHash === hash && memoryComplete;
          const latestNeedsRepair =
            latestJob?.status === 'failed' || latestJob?.status === 'blocked';
          if (options.mode === 'repair' && textCurrent && !latestNeedsRepair) {
            const pending = inspections.get(targetLocale) ?? [];
            pending.push({
              source,
              documentId,
              leaves,
              translations: state!.translations!,
              state: state!,
            });
            inspections.set(targetLocale, pending);
            continue;
          }
          const providerRequired = !textCurrent && leaves.length > 0;
          select(documentId, targetLocale, providerRequired, characters);
        }
      }

      for (const [targetLocale, pending] of inspections) {
        const documentIds = pending.map((candidate) => candidate.documentId);
        const relationExistence = await resolveRelationExistence(
          strapi,
          mergeRelationTargets(
            strapi,
            uid,
            pending.map((candidate) => candidate.source),
          ),
          targetLocale,
        );
        const targetRows: any[] = await strapi.db.query(uid as any).findMany({
          where: { locale: targetLocale, documentId: { $in: documentIds } },
          select: ['documentId'],
        } as any);
        const targetIds = new Set(
          (targetRows ?? []).map((row) => String(row.documentId)),
        );
        const desiredById = new Map<string, ReturnType<typeof buildLocalizedData>>();
        const fallbackIds: string[] = [];

        for (const candidate of pending) {
          const desired = buildLocalizedData(
            strapi,
            uid,
            candidate.source,
            new Map(Object.entries(candidate.translations)),
            relationExistence,
          );
          desiredById.set(candidate.documentId, desired);
          const planHash = localizedPlanHash(uid, desired.data);
          const hashCurrent =
            !inspectPersistedPlan &&
            targetIds.has(candidate.documentId) &&
            desired.skippedRelations.length === 0 &&
            candidate.state.publishedPlanHash === planHash;
          if (hashCurrent) {
            scan.skippedCurrent += 1;
          } else if (targetIds.has(candidate.documentId)) {
            fallbackIds.push(candidate.documentId);
          } else {
            select(candidate.documentId, targetLocale, false, 0);
          }
        }

        const loadedFallbacks = fallbackIds.length > 0
          ? await loadPopulatedEntries(strapi, uid, fallbackIds, targetLocale)
          : [];
        const fallbackEntries = new Map(
          loadedFallbacks.map(
            (entry) => [String(entry.documentId), entry],
          ),
        );
        for (const candidate of pending) {
          if (!fallbackIds.includes(candidate.documentId)) continue;
          const desired = desiredById.get(candidate.documentId)!;
          const inspection = inspectPopulatedLocaleVersion(
            strapi,
            uid,
            fallbackEntries.get(candidate.documentId) ?? null,
            desired,
          );
          if (inspection.current && inspection.skippedRelations.length === 0) {
            scan.skippedCurrent += 1;
            if (options.persistPlanHashes) {
              await store.recordPublishedPlanHash(
                uid,
                candidate.documentId,
                targetLocale,
                inspection.planHash,
              );
            }
          } else {
            select(candidate.documentId, targetLocale, false, 0);
          }
        }
      }

      progress.documentsScanned += page.entries.length;
      if (inputs.length > 0 && options.onPage) {
        scan.enqueued += await options.onPage(inputs);
      }
      await report({
        uidIndex,
        lastSourceId: page.lastId,
        documentsScanned: progress.documentsScanned,
        scan,
      });
      await throttlePage(pageStartedAt, page.entries.length);
    }
    progress.uidsDone = uidIndex + 1;
    await report({
      uidIndex: uidIndex + 1,
      lastSourceId: 0,
      documentsScanned: progress.documentsScanned,
      scan,
    });
  }
  progress.currentUid = null;
  await report();
  return scan;
}

export type BackfillOptions = {
  uids?: string[];
  locales?: string[];
  force?: boolean;
  reason?: string;
  mode?: BackfillMode;
  onProgress?: (progress: BackfillProgress) => void | Promise<void>;
  /** Internal durable-run cursor; never accepted from the HTTP request. */
  checkpoint?: BackfillCheckpoint | null;
  onCheckpoint?: ScanOptions['onCheckpoint'];
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
    onCheckpoint: options.onCheckpoint,
    checkpoint: options.checkpoint,
    persistPlanHashes: true,
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
    onCheckpoint: options.onCheckpoint,
    checkpoint: options.checkpoint,
    persistPlanHashes: false,
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
