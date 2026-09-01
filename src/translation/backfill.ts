// One-time BULK BACKFILL: enqueue every default-locale entry of every
// localized type into the same outbox the incremental pipeline drains. The
// migration package is deliberately NOT used here — its raw SQL bypasses
// sanitization, validation and ISR, which is exactly what LLM output must
// not skip. Re-running is free: pending jobs coalesce, and hash-current
// entries no-op at claim time.
import type { Core } from '@strapi/strapi';
import { estimateBackfillCost, type CostEstimate } from './cost';
import { translationConfigFromEnv } from './config';
import { collectTranslatableLeaves } from './field-map';
import { enabledContentLocales } from './locales/registry';
import { wakeTranslationOutbox } from './outbox/runtime';
import { insertTranslationJobsBulk, type TranslationJobInsert } from './outbox/store';
import { UI_DICTIONARY_UID } from './ui-dictionary/constants';
import { enqueueUiDictionaryJobs } from './ui-dictionary/enqueue';
import { UiDictionaryStore } from './ui-dictionary/store';
import { loadPopulatedEntry } from './writer';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';

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
  enqueued: number;
  perUid: Record<string, number>;
  locales: string[];
};

export async function enqueueTranslationBackfill(
  strapi: Core.Strapi,
  options: { uids?: string[]; locales?: string[]; force?: boolean } = {},
): Promise<BackfillResult> {
  const enabled = await enabledContentLocales(strapi);
  const locales = enabled
    .map((locale) => locale.code)
    .filter((code) => !options.locales || options.locales.includes(code));
  const uids = localizedApiUids(strapi).filter(
    (uid) => !options.uids || options.uids.includes(uid),
  );
  const perUid: Record<string, number> = {};
  let enqueued = 0;
  if (locales.length === 0) return { enqueued, perUid, locales };

  for (const uid of uids) {
    perUid[uid] = 0;
    for await (const page of defaultLocaleDocumentIds(strapi, uid)) {
      const inputs: TranslationJobInsert[] = page.flatMap((documentId) =>
        locales.map((targetLocale) => ({
          uid,
          documentId,
          targetLocale,
          kind: 'translate' as const,
          force: options.force === true,
          reason: 'backfill',
        })),
      );
      if (!inputs.length) continue;
      await strapi.db.transaction(async ({ trx }: any) => {
        await insertTranslationJobsBulk(trx, inputs);
      });
      perUid[uid] += page.length;
      enqueued += inputs.length;
    }
  }
  // After the content waves: the storefront's UI text, one job per locale
  // (inert unless the translation runtime is up — same as every enqueue).
  if (includesDictionary(options.uids)) {
    const dictionary = await enqueueUiDictionaryJobs(strapi, {
      locales,
      force: options.force === true,
      reason: 'backfill',
    });
    perUid[UI_DICTIONARY_UID] = dictionary.enqueued.length;
    enqueued += dictionary.enqueued.length;
  }
  wakeTranslationOutbox();
  return { enqueued, perUid, locales };
}

/**
 * Dry-run cost estimate: walks every entry's translatable leaves (no LLM
 * calls) and prices the batch with the configured rates. Slow-ish by nature
 * (it populates every document once) — a one-off super-admin read.
 */
export async function estimateTranslationBackfill(
  strapi: Core.Strapi,
  options: { uids?: string[]; locales?: string[] } = {},
): Promise<CostEstimate & { perUid: Record<string, number>; locales: string[] }> {
  const config = translationConfigFromEnv();
  const locales = (await enabledContentLocales(strapi))
    .map((locale) => locale.code)
    .filter((code) => !options.locales || options.locales.includes(code));
  const uids = localizedApiUids(strapi).filter(
    (uid) => !options.uids || options.uids.includes(uid),
  );
  const perEntryChars: number[] = [];
  const perUid: Record<string, number> = {};
  for (const uid of uids) {
    perUid[uid] = 0;
    for await (const page of defaultLocaleDocumentIds(strapi, uid)) {
      for (const documentId of page) {
        const entry = await loadPopulatedEntry(
          strapi,
          uid,
          documentId,
          DEFAULT_CONTENT_LOCALE,
        );
        if (!entry) continue;
        const leaves = collectTranslatableLeaves(strapi, uid, entry);
        const chars = leaves.reduce((sum, leaf) => sum + leaf.value.length, 0);
        perEntryChars.push(chars);
        perUid[uid] += 1;
      }
    }
  }
  // The system prompt (brief + contract) rides along once per call.
  const promptOverheadChars = 6_000;
  const localeEntries = perEntryChars.flatMap((chars) =>
    locales.map(() => chars),
  );
  // The dictionary is already per locale: one line per locale holding the
  // characters of every key still missing or stale there. Nothing pending
  // (or translation off → no locales) adds no line at all.
  if (includesDictionary(options.uids) && locales.length > 0) {
    const dictionary = new UiDictionaryStore(strapi);
    perUid[UI_DICTIONARY_UID] = 0;
    for (const locale of locales) {
      const leaves = await dictionary.pendingLeaves(locale, false);
      const chars = leaves.reduce((sum, leaf) => sum + leaf.text.length, 0);
      perUid[UI_DICTIONARY_UID] += leaves.length;
      if (chars > 0) localeEntries.push(chars);
    }
  }
  const estimate = estimateBackfillCost(
    config ?? { inputCostPerMTok: 0, outputCostPerMTok: 0, chunkChars: 12_000 },
    localeEntries,
    promptOverheadChars,
    2,
  );
  return { ...estimate, perUid, locales };
}
