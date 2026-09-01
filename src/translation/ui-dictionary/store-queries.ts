// knex-level access to `ui_catalogue` / `ui_translations`: row mapping,
// loaders and the two upsert statements. No locking or transaction policy
// here — store.ts owns that.
import {
  UI_CATALOGUE_TABLE,
  UI_TRANSLATIONS_TABLE,
} from './constants';
import { splitPluralKey } from './plural';
import type { CatalogueUpsertRow } from './sync-plan';
import { CATALOGUE_MERGE_COLUMNS } from './sync-plan';
import type {
  CatalogueRow,
  TranslationOrigin,
  TranslationRow,
} from './types';

/** knex connection or transaction — both are callable as `db(table)`. */
export type Db = any;

const CHUNK = 500;

export const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext(?))';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function toCatalogueRow(row: any): CatalogueRow {
  return {
    key: String(row.key),
    text: String(row.text ?? ''),
    description: row.description ?? null,
    maxLength: integerOrNull(row.max_length),
    pluralOf: row.plural_of ?? null,
    hash: String(row.hash ?? ''),
    overrideText: row.override_text ?? null,
    effectiveHash: String(row.effective_hash ?? ''),
    overrideUpdatedBy: integerOrNull(row.override_updated_by),
    overrideUpdatedAt: iso(row.override_updated_at),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    removedAt: iso(row.removed_at),
  };
}

export function toTranslationRow(row: any): TranslationRow {
  return {
    locale: String(row.locale),
    key: String(row.key),
    text: String(row.text ?? ''),
    sourceHash: String(row.source_hash ?? ''),
    origin: row.origin === 'manual' ? 'manual' : 'ai',
    updatedBy: integerOrNull(row.updated_by),
    updatedAt: iso(row.updated_at),
  };
}

export async function loadCatalogueRows(
  db: Db,
  options: { includeRemoved?: boolean } = {},
): Promise<CatalogueRow[]> {
  const query = db(UI_CATALOGUE_TABLE).select('*').orderBy('key', 'asc');
  if (!options.includeRemoved) query.whereNull('removed_at');
  const rows: any[] = await query;
  return rows.map(toCatalogueRow);
}

/**
 * Live rows for `keys`, plus the `base.other` row of every key that could be
 * a plural expansion — enough for `resolveSourceRow` to answer for each key.
 */
export async function loadLiveCatalogueRowsForKeys(
  db: Db,
  keys: readonly string[],
): Promise<Map<string, CatalogueRow>> {
  const candidates = new Set<string>();
  for (const key of keys) {
    candidates.add(key);
    const split = splitPluralKey(key);
    if (split) candidates.add(`${split.base}.other`);
  }
  const result = new Map<string, CatalogueRow>();
  const list = [...candidates];
  for (let start = 0; start < list.length; start += CHUNK) {
    const rows: any[] = await db(UI_CATALOGUE_TABLE)
      .select('*')
      .whereIn('key', list.slice(start, start + CHUNK))
      .whereNull('removed_at');
    for (const row of rows) {
      const mapped = toCatalogueRow(row);
      result.set(mapped.key, mapped);
    }
  }
  return result;
}

export async function loadTranslationRows(
  db: Db,
  locale?: string,
): Promise<TranslationRow[]> {
  const query = db(UI_TRANSLATIONS_TABLE).select('*').orderBy('key', 'asc');
  if (locale !== undefined) query.where('locale', locale);
  const rows: any[] = await query;
  return rows.map(toTranslationRow);
}

export async function upsertCatalogueRows(
  trx: Db,
  upserts: readonly CatalogueUpsertRow[],
): Promise<void> {
  for (let start = 0; start < upserts.length; start += CHUNK) {
    await trx(UI_CATALOGUE_TABLE)
      .insert(upserts.slice(start, start + CHUNK))
      .onConflict('key')
      .merge([...CATALOGUE_MERGE_COLUMNS]);
  }
}

export async function markCatalogueRemoved(
  trx: Db,
  keys: readonly string[],
  now: Date,
): Promise<void> {
  for (let start = 0; start < keys.length; start += CHUNK) {
    await trx(UI_CATALOGUE_TABLE)
      .whereIn('key', keys.slice(start, start + CHUNK))
      .whereNull('removed_at')
      .update({ removed_at: now });
  }
}

export type TranslationUpsert = { key: string; text: string; sourceHash: string };

/**
 * INSERT … ON CONFLICT (locale, key) DO UPDATE. With `guardManual`, a
 * current MANUAL row wins over the incoming (AI) text; a stale manual row is
 * replaced because its English source moved. Returns rows inserted+updated
 * (Postgres does not count rows the DO UPDATE … WHERE clause skipped).
 */
export async function upsertTranslations(
  trx: Db,
  locale: string,
  rows: readonly TranslationUpsert[],
  origin: TranslationOrigin,
  userId: number | null,
  guardManual: boolean,
): Promise<number> {
  let written = 0;
  const now = new Date();
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const bindings = chunk.flatMap((row) => [
      locale,
      row.key,
      row.text,
      row.sourceHash,
      origin,
      userId,
      now,
    ]);
    const result = await trx.raw(
      `INSERT INTO ${UI_TRANSLATIONS_TABLE} ` +
        `(locale, key, text, source_hash, origin, updated_by, updated_at) ` +
        `VALUES ${values} ` +
        `ON CONFLICT (locale, key) DO UPDATE SET ` +
        `text = excluded.text, source_hash = excluded.source_hash, ` +
        `origin = excluded.origin, updated_by = excluded.updated_by, ` +
        `updated_at = excluded.updated_at` +
        (guardManual
          ? ` WHERE ${UI_TRANSLATIONS_TABLE}.origin <> 'manual' ` +
            `OR ${UI_TRANSLATIONS_TABLE}.source_hash <> excluded.source_hash`
          : ''),
      bindings,
    );
    written += Number(result?.rowCount ?? 0);
  }
  return written;
}
