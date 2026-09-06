// UI-text dictionary STORE: the write policy (advisory locks, transaction
// scope, the "manual wins until its English moves" merge guard) and the read
// surface the content API, the translation job (B2) and the admin page (B3)
// call. Runs on the raw knex connection — none of these writes happen inside
// a content transaction (see AGENTS.md).
import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import {
  CATALOGUE_LOCK_NAME,
  localeLockName,
  MAX_TEXT_LENGTH,
  UI_CATALOGUE_TABLE,
  UI_DICTIONARY_STORE,
  UI_TRANSLATIONS_TABLE,
} from './constants';
import {
  buildEntries,
  effectiveText,
  selectPendingLeaves,
} from './entries';
import { catalogueEntryHash } from './hash';
import { resolveSourceRow } from './plural';
import {
  type Db,
  loadCatalogueRows,
  loadLiveCatalogueRowsForKeys,
  loadTranslationRows,
  markCatalogueRemoved,
  toCatalogueRow,
  type TranslationUpsert,
  upsertCatalogueRows,
  upsertTranslations,
} from './store-queries';
import { advisoryTransactionLock, isPostgresConnection } from '../../utils/database-dialect';
import { planCatalogueSync } from './sync-plan';
import type {
  AiTranslationWrite,
  AiTranslationWriteResult,
  CatalogueRow,
  CatalogueSyncInput,
  CatalogueSyncResult,
  ImportMessagesResult,
  PublicDictionary,
  UiCatalogueMeta,
  UiDictionaryEntry,
  UiDictionaryPendingLeaf,
  UiDictionarySummary,
} from './types';

export type UiDictionaryErrorCode = 'UNKNOWN_KEY' | 'INVALID_TEXT' | 'INVALID_LOCALE';

export class UiDictionaryError extends Error {
  constructor(
    readonly code: UiDictionaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UiDictionaryError';
  }
}

/** Shape check only; placeholder preservation is the admin route's job (B3). */
export function textProblem(text: unknown, row?: Pick<CatalogueRow, 'maxLength'>): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) return 'text must be a non-empty string';
  if (text.length > MAX_TEXT_LENGTH) return `text must not exceed ${MAX_TEXT_LENGTH} characters`;
  if (row?.maxLength && text.length > row.maxLength) {
    return `text must not exceed the declared maxLength of ${row.maxLength}`;
  }
  return null;
}

// Strapi's core store table and the key `strapi.store(UI_DICTIONARY_STORE)`
// derives (`<type>_<name>_<key>`), so either access path sees the same row.
const CORE_STORE_TABLE = 'strapi_core_store_settings';
const META_STORE_KEY = `${UI_DICTIONARY_STORE.type}_${UI_DICTIONARY_STORE.name}_${UI_DICTIONARY_STORE.key}`;

function isMeta(value: unknown): value is UiCatalogueMeta {
  const meta = value as UiCatalogueMeta | null;
  return Boolean(meta && typeof meta.version === 'string' && typeof meta.pushedAt === 'string');
}

function latest(...values: Array<string | null | undefined>): string | null {
  let result: string | null = null;
  for (const value of values) {
    if (value && (!result || value > result)) result = value;
  }
  return result;
}

export class UiDictionaryStore {
  constructor(private readonly strapi: Core.Strapi) {}

  private get db(): Db {
    return this.strapi.db.connection;
  }

  private transaction<T>(callback: (trx: Db) => Promise<T>): Promise<T> {
    return this.strapi.db.transaction(
      ({ trx }: any) => callback(trx),
    ) as unknown as Promise<T>;
  }

  /**
   * Catalogue meta lives in Strapi's core store under the same key
   * `strapi.store(UI_DICTIONARY_STORE)` would use, but is read and written
   * through the caller's connection so `syncCatalogue` can commit the rows
   * AND the version atomically: a version bumped on its own connection while
   * the row transaction rolled back would make the next push short-circuit
   * as "unchanged" against an old catalogue.
   */
  async readMeta(db: Db = this.db): Promise<UiCatalogueMeta | null> {
    const row = (await db(CORE_STORE_TABLE)
      .where({ key: META_STORE_KEY })
      .select('value')
      .first()) as { value?: unknown } | undefined;
    if (!row) return null;
    let value = row.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    return isMeta(value) ? value : null;
  }

  async writeMeta(meta: UiCatalogueMeta, db: Db = this.db): Promise<void> {
    const value = JSON.stringify(meta);
    const updated = await db(CORE_STORE_TABLE)
      .where({ key: META_STORE_KEY })
      .update({ value, type: 'object' });
    if (Number(updated) === 0) {
      await db(CORE_STORE_TABLE).insert([
        { key: META_STORE_KEY, value, type: 'object', environment: null, tag: null },
      ]);
    }
  }

  /** Idempotent by version; the whole diff commits or nothing does. */
  async syncCatalogue(input: CatalogueSyncInput): Promise<CatalogueSyncResult> {
    return this.transaction(async (trx) => {
      await advisoryTransactionLock(trx, CATALOGUE_LOCK_NAME);
      const meta = await this.readMeta(trx);
      if (meta?.version === input.version) {
        return { unchanged: true, added: 0, changed: 0, removed: 0, touchedKeys: [], version: input.version };
      }
      const existing = (
        (await trx(UI_CATALOGUE_TABLE).select('key', 'hash', 'override_text', 'removed_at')) as any[]
      ).map(toCatalogueRow);
      const now = new Date();
      const plan = planCatalogueSync(existing, input.entries, now);
      await upsertCatalogueRows(trx, plan.upserts);
      await markCatalogueRemoved(trx, plan.removed, now);
      const counts = {
        total: plan.upserts.length,
        added: plan.added.length,
        changed: plan.changed.length,
        removed: plan.removed.length,
      };
      await this.writeMeta({ version: input.version, pushedAt: now.toISOString(), counts }, trx);
      return {
        unchanged: false,
        added: counts.added,
        changed: counts.changed,
        removed: counts.removed,
        touchedKeys: [...plan.added, ...plan.changed, ...plan.revived].sort(),
        version: input.version,
      };
    });
  }

  async listEntries(
    locale: string,
    options: { includeRemoved?: boolean } = {},
  ): Promise<UiDictionaryEntry[]> {
    const [catalogue, translations] = await Promise.all([
      loadCatalogueRows(this.db, options),
      locale === DEFAULT_CONTENT_LOCALE ? [] : loadTranslationRows(this.db, locale),
    ]);
    return buildEntries({ locale, catalogue, translations, includeRemoved: options.includeRemoved });
  }

  async pendingLeaves(locale: string, force = false): Promise<UiDictionaryPendingLeaf[]> {
    if (locale === DEFAULT_CONTENT_LOCALE) return [];
    const [catalogue, translations] = await Promise.all([
      loadCatalogueRows(this.db),
      loadTranslationRows(this.db, locale),
    ]);
    return selectPendingLeaves({ locale, catalogue, translations, force });
  }

  /** The translation job's write: drops rows whose English moved meanwhile. */
  async writeAiTranslations(
    locale: string,
    rows: readonly AiTranslationWrite[],
  ): Promise<AiTranslationWriteResult> {
    this.assertTranslationLocale(locale);
    if (rows.length === 0) return { written: 0, staleDropped: [], guarded: 0 };
    return this.transaction(async (trx) => {
      await advisoryTransactionLock(trx, localeLockName(locale));
      const current = await loadLiveCatalogueRowsForKeys(trx, rows.map((row) => row.key));
      const accepted: TranslationUpsert[] = [];
      const staleDropped: string[] = [];
      for (const row of rows) {
        const source = resolveSourceRow(current, row.key);
        if (source && source.row.effectiveHash === row.sourceHash) accepted.push(row);
        else staleDropped.push(row.key);
      }
      const written = await upsertTranslations(trx, locale, accepted, 'ai', null, true);
      return { written, staleDropped, guarded: accepted.length - written };
    });
  }

  async writeManualTranslation(
    locale: string,
    key: string,
    text: string,
    userId: number | null,
  ): Promise<{ key: string; sourceHash: string }> {
    this.assertTranslationLocale(locale);
    return this.transaction(async (trx) => {
      await advisoryTransactionLock(trx, localeLockName(locale));
      const source = resolveSourceRow(await loadLiveCatalogueRowsForKeys(trx, [key]), key);
      if (!source) throw new UiDictionaryError('UNKNOWN_KEY', `${key} is not in the catalogue`);
      const problem = textProblem(text, source.row);
      if (problem) throw new UiDictionaryError('INVALID_TEXT', problem);
      const sourceHash = source.row.effectiveHash;
      await upsertTranslations(trx, locale, [{ key, text, sourceHash }], 'manual', userId, false);
      return { key, sourceHash };
    });
  }

  async deleteTranslation(locale: string, key: string): Promise<boolean> {
    const deleted = await this.db(UI_TRANSLATIONS_TABLE).where({ locale, key }).delete();
    return Number(deleted) > 0;
  }

  /** `text === null` (or equal to the pushed text) clears the override. */
  async writeEnglishOverride(
    key: string,
    text: string | null,
    userId: number | null,
  ): Promise<{ key: string; overrideText: string | null; effectiveHash: string; changed: boolean }> {
    return this.transaction(async (trx) => {
      await advisoryTransactionLock(trx, CATALOGUE_LOCK_NAME);
      const row = (await loadLiveCatalogueRowsForKeys(trx, [key])).get(key);
      if (!row) throw new UiDictionaryError('UNKNOWN_KEY', `${key} is not in the catalogue`);
      return this.applyEnglishOverride(trx, row, text, userId);
    });
  }

  private async applyEnglishOverride(
    trx: Db,
    row: CatalogueRow,
    text: string | null,
    userId: number | null,
  ) {
    if (text !== null) {
      const problem = textProblem(text, row);
      if (problem) throw new UiDictionaryError('INVALID_TEXT', problem);
    }
    const overrideText = text === null || text === row.text ? null : text;
    const effectiveHash = catalogueEntryHash(overrideText ?? row.text, row.maxLength);
    const changed = effectiveHash !== row.effectiveHash;
    await trx(UI_CATALOGUE_TABLE)
      .where({ key: row.key })
      .update({
        override_text: overrideText,
        effective_hash: effectiveHash,
        override_updated_by: overrideText === null ? null : userId,
        override_updated_at: overrideText === null ? null : new Date(),
      });
    return { key: row.key, overrideText, effectiveHash, changed };
  }

  /**
   * The storefront contract: English → overrides only (nothing overridden →
   * `{}`); other locales → overrides under the locale's translations, stale
   * ones included (a stale translation beats English). Removed keys and
   * translations of removed keys are never served.
   */
  async publicMessages(locale: string): Promise<Record<string, string>> {
    return (await this.publicDictionary(locale)).messages;
  }

  async publicDictionary(locale: string): Promise<PublicDictionary> {
    const isEnglish = locale === DEFAULT_CONTENT_LOCALE;
    const read = async (db: Db) => {
      const meta = await this.readMeta(db);
      const [catalogue, translations] = await Promise.all([
        loadCatalogueRows(db),
        isEnglish ? [] : loadTranslationRows(db, locale),
      ]);
      return [meta, catalogue, translations] as const;
    };
    // A dedicated read-only snapshot prevents a concurrent catalogue commit
    // from pairing a new version with old rows (or the reverse). Do not inherit
    // an ambient write transaction whose isolation may already be established.
    const snapshot: Awaited<ReturnType<typeof read>> = await this.db.transaction(read,
      isPostgresConnection(this.db) ? { isolationLevel: 'repeatable read', readOnly: true } : {});
    const [meta, catalogue, translations] = snapshot;
    const messages: Record<string, string> = {};
    let updatedAt = meta?.pushedAt ?? null;
    for (const row of catalogue) {
      if (row.overrideText === null) continue;
      messages[row.key] = row.overrideText;
      updatedAt = latest(updatedAt, row.overrideUpdatedAt);
    }
    if (!isEnglish) {
      const liveByKey = new Map(catalogue.map((row) => [row.key, row]));
      for (const row of translations) {
        if (!resolveSourceRow(liveByKey, row.key)) continue;
        messages[row.key] = row.text;
        updatedAt = latest(updatedAt, row.updatedAt);
      }
    }
    // Ready means "translated for THIS catalogue version": every live entry
    // (plural expansions included) has text whose source hash matches the
    // entry's effective hash. A stale row still serves above (better than
    // English) but must not let a release ship with the previous wording —
    // the deploy gates and the SSR readiness endpoint key on this flag.
    const ready = isEnglish || (catalogue.length > 0 && buildEntries({ locale, catalogue, translations })
      .every((entry) => (entry.status === 'ai' || entry.status === 'manual') && Boolean(entry.translation?.text.trim())));
    return { locale, version: meta?.version ?? null, updatedAt, messages, ready };
  }

  /** Per-locale counts (plural expansions included) for `locales` ∪ locales with rows. */
  async summary(locales: readonly string[] = []): Promise<UiDictionarySummary> {
    const [catalogue, translations] = await Promise.all([
      loadCatalogueRows(this.db, { includeRemoved: true }),
      loadTranslationRows(this.db),
    ]);
    const live = catalogue.filter((row) => !row.removedAt);
    const codes = new Set([...locales, ...translations.map((row) => row.locale)]);
    codes.delete(DEFAULT_CONTENT_LOCALE);
    const result: UiDictionarySummary = {
      catalogue: {
        total: live.length,
        overridden: live.filter((row) => row.overrideText !== null).length,
        removed: catalogue.length - live.length,
      },
      locales: {},
    };
    for (const locale of [...codes].sort()) {
      const counts = { translated: 0, ai: 0, manual: 0, stale: 0, missing: 0 };
      const entries = buildEntries({
        locale,
        catalogue: live,
        translations: translations.filter((row) => row.locale === locale),
      });
      for (const entry of entries) {
        if (entry.translation) counts.translated += 1;
        if (entry.status === 'ai' || entry.status === 'manual' || entry.status === 'stale' || entry.status === 'missing') {
          counts[entry.status] += 1;
        }
      }
      result.locales[locale] = counts;
    }
    return result;
  }

  /** JSON import: English → overrides; other locales → manual translations. */
  async importMessages(
    locale: string,
    messages: Record<string, unknown>,
    userId: number | null,
  ): Promise<ImportMessagesResult> {
    const isEnglish = locale === DEFAULT_CONTENT_LOCALE;
    return this.transaction(async (trx) => {
      await advisoryTransactionLock(
        trx,
        isEnglish ? CATALOGUE_LOCK_NAME : localeLockName(locale),
      );
      const liveByKey = new Map((await loadCatalogueRows(trx)).map((row) => [row.key, row]));
      const result: ImportMessagesResult = { written: 0, skipped: [] };
      const writes: TranslationUpsert[] = [];
      for (const key of Object.keys(messages).sort()) {
        const text = messages[key];
        const source = isEnglish
          ? liveByKey.has(key) ? { row: liveByKey.get(key)!, expandedCategory: null } : null
          : resolveSourceRow(liveByKey, key);
        const problem = source ? textProblem(text, source.row) : 'key is not in the catalogue';
        if (!source || problem) {
          result.skipped.push({ key, reason: problem ?? 'key is not in the catalogue' });
          continue;
        }
        if (isEnglish) {
          await this.applyEnglishOverride(trx, source.row, text as string, userId);
          result.written += 1;
        } else {
          writes.push({ key, text: text as string, sourceHash: source.row.effectiveHash });
        }
      }
      if (writes.length > 0) {
        result.written += await upsertTranslations(trx, locale, writes, 'manual', userId, false);
      }
      return result;
    });
  }

  /** English → effective text of every live key; other → the locale's stored rows. */
  async exportMessages(locale: string): Promise<Record<string, string>> {
    const entries = await this.listEntries(locale);
    const messages: Record<string, string> = {};
    for (const entry of entries) {
      if (locale === DEFAULT_CONTENT_LOCALE) messages[entry.key] = effectiveText(entry.source);
      else if (entry.translation) messages[entry.key] = entry.translation.text;
    }
    return messages;
  }

  private assertTranslationLocale(locale: string): void {
    if (locale === DEFAULT_CONTENT_LOCALE || !locale) {
      throw new UiDictionaryError(
        'INVALID_LOCALE',
        'translations are stored for non-default locales only; English uses overrides',
      );
    }
  }
}
