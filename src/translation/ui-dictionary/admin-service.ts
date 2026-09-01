// Settings → UI Text: the request-level policy behind the admin routes —
// locale/key/text validation, placeholder preservation, the write → purge →
// sweep → (re)translate sequence — kept out of the controller so it can be
// unit-tested against a stubbed store. Status codes travel as
// UiDictionaryAdminError; the controller only maps them onto ctx.
import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import { purgeResponseCaches } from '../../middlewares/cache';
import { enabledContentLocales } from '../locales/registry';
import { translationRuntimeActive, translationStore } from '../outbox/runtime';
import { keepsProtectedValues } from '../placeholders';
import {
  MAX_CATALOGUE_KEYS,
  MAX_KEY_LENGTH,
  UI_DICTIONARY_DOCUMENT_ID,
  UI_DICTIONARY_UID,
} from './constants';
import { effectiveText } from './entries';
import { enqueueUiDictionaryJobs } from './enqueue';
import { requestUiDictionarySweep } from './isr';
import { resolveSourceRow, type ResolvedSource } from './plural';
import { textProblem, UiDictionaryError, UiDictionaryStore } from './store';
import { loadLiveCatalogueRowsForKeys } from './store-queries';
import type {
  CatalogueRow,
  ImportMessagesResult,
  UiCatalogueMeta,
  UiDictionaryEntry,
  UiDictionarySummary,
} from './types';

/** Public-cache prefix of the storefront read (src/api/ui-dictionary/routes). */
export const UI_DICTIONARY_CACHE_PREFIX = '/api/ui-dictionary';

export class UiDictionaryAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UiDictionaryAdminError';
  }
}

export type UiDictionaryLanguage = {
  code: string;
  name: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
};

export type UiDictionaryJobState = {
  status: string;
  attemptCount: number;
  lastError: string | null;
} | null;

export type UiDictionaryStatus = {
  translationActive: boolean;
  /** English first, then every enabled target language. */
  languages: UiDictionaryLanguage[];
  catalogue: UiCatalogueMeta | null;
  perLocale: UiDictionarySummary;
  /** Newest dictionary job per target locale; null when unavailable. */
  jobs: Record<string, UiDictionaryJobState> | null;
};

const ENGLISH: UiDictionaryLanguage = {
  code: DEFAULT_CONTENT_LOCALE,
  name: 'English',
  nativeName: 'English',
  dir: 'ltr',
};

function badRequest(message: string, details?: Record<string, unknown>) {
  return new UiDictionaryAdminError(400, message, details);
}

function fromStoreError(err: unknown): never {
  if (err instanceof UiDictionaryError) {
    throw new UiDictionaryAdminError(err.code === 'UNKNOWN_KEY' ? 404 : 400, err.message);
  }
  throw err;
}

function parseKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || key.length > MAX_KEY_LENGTH) throw badRequest('key is required.');
  return key;
}

function parseText(raw: unknown): string {
  const problem = textProblem(raw);
  if (problem) throw badRequest(problem);
  return (raw as string).trim();
}

export class UiDictionaryAdminService {
  private readonly store: UiDictionaryStore;

  constructor(
    private readonly strapi: Core.Strapi,
    store?: UiDictionaryStore,
  ) {
    this.store = store ?? new UiDictionaryStore(strapi);
  }

  async status(): Promise<UiDictionaryStatus> {
    const [targets, translationActive, catalogue] = await Promise.all([
      enabledContentLocales(this.strapi),
      translationRuntimeActive(this.strapi),
      this.store.readMeta(),
    ]);
    const codes = targets.map((locale) => locale.code);
    const [perLocale, jobs] = await Promise.all([
      this.store.summary(codes),
      codes.length > 0 ? this.jobStates(codes) : Promise.resolve(null),
    ]);
    return {
      translationActive,
      languages: [
        ENGLISH,
        ...targets.map(({ code, name, nativeName, dir }) => ({ code, name, nativeName, dir })),
      ],
      catalogue,
      perLocale,
      jobs,
    };
  }

  async entries(
    rawLocale: unknown,
    includeRemoved: boolean,
  ): Promise<{ locale: string; entries: UiDictionaryEntry[] }> {
    const locale = await this.allowedLocale(rawLocale);
    return { locale, entries: await this.store.listEntries(locale, { includeRemoved }) };
  }

  async upsertEntry(rawLocale: unknown, rawKey: unknown, rawText: unknown, userId: number | null) {
    const locale = await this.allowedLocale(rawLocale);
    const key = parseKey(rawKey);
    const text = parseText(rawText);
    const source = await this.requireSource(locale, key);
    const problem = textProblem(text, source.row);
    if (problem) throw badRequest(problem);
    // An override is checked against the pushed English; a translation
    // against what the UI shows in English (override ?? pushed).
    const english = locale === DEFAULT_CONTENT_LOCALE ? source.row.text : effectiveText(source.row);
    const verdict = keepsProtectedValues(english, text);
    if (!verdict.ok) {
      throw badRequest(
        `The text must keep these placeholders from the English source: ${verdict.missing.join(', ')}`,
        { missing: verdict.missing },
      );
    }
    if (locale === DEFAULT_CONTENT_LOCALE) {
      const result = await this.store.writeEnglishOverride(key, text, userId).catch(fromStoreError);
      const jobs = result.changed ? await this.enqueue({ reason: 'english override' }) : [];
      await this.afterWrite();
      return { locale, ...result, jobs };
    }
    const result = await this.store.writeManualTranslation(locale, key, text, userId).catch(fromStoreError);
    await this.afterWrite();
    return { locale, ...result };
  }

  async deleteEntry(rawLocale: unknown, rawKey: unknown, userId: number | null) {
    const locale = await this.allowedLocale(rawLocale);
    const key = parseKey(rawKey);
    if (locale === DEFAULT_CONTENT_LOCALE) {
      const result = await this.store.writeEnglishOverride(key, null, userId).catch(fromStoreError);
      const jobs = result.changed ? await this.enqueue({ reason: 'english override' }) : [];
      await this.afterWrite();
      return { locale, key, cleared: result.changed, jobs };
    }
    const deleted = await this.store.deleteTranslation(locale, key);
    if (!deleted) return { locale, key, deleted: false, jobs: [] };
    const jobs = await this.enqueue({ locales: [locale], force: false, reason: 'reset to ai' });
    await this.afterWrite();
    return { locale, key, deleted: true, jobs };
  }

  async importMessages(body: unknown, userId: number | null) {
    const input = (body ?? {}) as { locale?: unknown; messages?: unknown };
    const locale = await this.allowedLocale(input.locale);
    const messages = input.messages;
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
      throw badRequest('messages must be an object of key → text.');
    }
    const keys = Object.keys(messages);
    if (keys.length > MAX_CATALOGUE_KEYS) {
      throw badRequest(`messages must not exceed ${MAX_CATALOGUE_KEYS} keys.`);
    }
    const { accepted, skipped } = await this.screenImport(locale, messages as Record<string, unknown>);
    const result: ImportMessagesResult =
      Object.keys(accepted).length > 0
        ? await this.store.importMessages(locale, accepted, userId)
        : { written: 0, skipped: [] };
    const allSkipped = [...skipped, ...result.skipped].sort((a, b) => (a.key < b.key ? -1 : 1));
    if (result.written === 0) return { locale, written: 0, skipped: allSkipped, jobs: [] };
    const jobs =
      locale === DEFAULT_CONTENT_LOCALE ? await this.enqueue({ reason: 'english import' }) : [];
    await this.afterWrite();
    return { locale, written: result.written, skipped: allSkipped, jobs };
  }

  async exportMessages(rawLocale: unknown) {
    const locale = await this.allowedLocale(rawLocale);
    return { locale, messages: await this.store.exportMessages(locale) };
  }

  async translate(body: unknown) {
    const input = (body ?? {}) as { locale?: unknown; force?: unknown };
    let locales: string[] | undefined;
    if (input.locale !== undefined && input.locale !== null && input.locale !== '') {
      const locale = await this.allowedLocale(input.locale);
      if (locale === DEFAULT_CONTENT_LOCALE) {
        throw badRequest('English is the source language and is never translated.');
      }
      locales = [locale];
    }
    if (!(await translationRuntimeActive(this.strapi))) {
      throw new UiDictionaryAdminError(
        409,
        'Translation is not active on this deployment (Country Setup switch or TRANSLATION_* env missing).',
      );
    }
    const force = input.force === true;
    const enqueued = await this.enqueue({ locales, force, reason: 'manual trigger' });
    return { enqueued, force };
  }

  /** `en` or an enabled target locale; anything else is a 400. */
  private async allowedLocale(raw: unknown): Promise<string> {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const locale = typeof value === 'string' ? value.trim() : '';
    if (locale === DEFAULT_CONTENT_LOCALE) return locale;
    const enabled = (await enabledContentLocales(this.strapi)).map((entry) => entry.code);
    if (locale && enabled.includes(locale)) return locale;
    throw badRequest(
      `locale must be one of: ${[DEFAULT_CONTENT_LOCALE, ...enabled].join(', ')}.`,
    );
  }

  /** The live catalogue row `key` translates from — 404 when there is none. */
  private async requireSource(locale: string, key: string): Promise<ResolvedSource> {
    const source = await this.sourceFor(locale, key);
    if (!source) throw new UiDictionaryAdminError(404, `${key} is not in the catalogue`);
    return source;
  }

  private async sourceFor(locale: string, key: string): Promise<ResolvedSource | null> {
    const rows = await loadLiveCatalogueRowsForKeys(this.strapi.db.connection, [key]);
    return this.resolve(locale, rows, key);
  }

  /** English overrides target pushed keys only; other locales may fill plural expansions. */
  private resolve(
    locale: string,
    rows: ReadonlyMap<string, CatalogueRow>,
    key: string,
  ): ResolvedSource | null {
    if (locale !== DEFAULT_CONTENT_LOCALE) return resolveSourceRow(rows, key);
    const row = rows.get(key);
    return row ? { row, expandedCategory: null } : null;
  }

  /** Drops keys whose text loses a placeholder; the store screens the rest. */
  private async screenImport(locale: string, messages: Record<string, unknown>) {
    const rows = await loadLiveCatalogueRowsForKeys(this.strapi.db.connection, Object.keys(messages));
    const accepted: Record<string, string> = {};
    const skipped: ImportMessagesResult['skipped'] = [];
    for (const [key, raw] of Object.entries(messages)) {
      const source = this.resolve(locale, rows, key);
      if (!source || typeof raw !== 'string') {
        accepted[key] = raw as string;
        continue;
      }
      const text = raw.trim();
      const english = locale === DEFAULT_CONTENT_LOCALE ? source.row.text : effectiveText(source.row);
      const verdict = keepsProtectedValues(english, text);
      if (verdict.ok) accepted[key] = text;
      else skipped.push({ key, reason: `missing placeholders: ${verdict.missing.join(', ')}` });
    }
    return { accepted, skipped };
  }

  private async enqueue(input: Parameters<typeof enqueueUiDictionaryJobs>[1]): Promise<string[]> {
    return (await enqueueUiDictionaryJobs(this.strapi, input)).enqueued;
  }

  /** Every successful write: drop the 60 s public cache, re-render the site. */
  private async afterWrite(): Promise<void> {
    purgeResponseCaches([UI_DICTIONARY_CACHE_PREFIX]);
    await requestUiDictionarySweep(this.strapi);
  }

  private async jobStates(codes: readonly string[]): Promise<Record<string, UiDictionaryJobState> | null> {
    try {
      const outbox = translationStore(this.strapi);
      const states = await Promise.all(
        codes.map((code) => outbox.activeJob(UI_DICTIONARY_UID, UI_DICTIONARY_DOCUMENT_ID, code)),
      );
      return Object.fromEntries(codes.map((code, index) => [code, states[index]]));
    } catch (err: any) {
      this.strapi.log.warn(`[ui-dictionary] job state unavailable: ${err?.message ?? err}`);
      return null;
    }
  }
}
