// The ONE staleness rule, applied to loaded rows: a translation is current
// while its `source_hash` equals the catalogue row's `effective_hash`. Used
// by the admin listing (status column), the translation job (pending work)
// and the summary counts, so the three can never disagree. Pure.
import { DEFAULT_CONTENT_LOCALE } from '../../constants/content-locales';
import {
  pluralExpansions,
  pluralNote,
  splitPluralKey,
} from './plural';
import type {
  CatalogueRow,
  EntryStatus,
  TranslationRow,
  UiDictionaryEntry,
  UiDictionaryPendingLeaf,
} from './types';

export function translationStatus(
  effectiveHash: string,
  translation: Pick<TranslationRow, 'sourceHash' | 'origin'> | null | undefined,
): Extract<EntryStatus, 'missing' | 'stale' | 'ai' | 'manual'> {
  if (!translation) return 'missing';
  if (translation.sourceHash !== effectiveHash) return 'stale';
  return translation.origin;
}

/**
 * Missing and stale rows always; current AI rows only under `force`;
 * current MANUAL rows never (an editor's text is kept until its English
 * source changes — the same rule as content).
 */
export function isPendingTranslation(
  effectiveHash: string,
  translation: Pick<TranslationRow, 'sourceHash' | 'origin'> | null | undefined,
  force: boolean,
): boolean {
  const status = translationStatus(effectiveHash, translation);
  return status === 'missing' || status === 'stale' || (force && status === 'ai');
}

export function effectiveText(row: Pick<CatalogueRow, 'text' | 'overrideText'>): string {
  return row.overrideText ?? row.text;
}

function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function toTranslation(
  row: TranslationRow | undefined,
): UiDictionaryEntry['translation'] {
  if (!row) return null;
  return {
    text: row.text,
    origin: row.origin,
    sourceHash: row.sourceHash,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export type EntriesInput = {
  locale: string;
  catalogue: readonly CatalogueRow[];
  /** Rows of `locale` only (ignored for the default locale). */
  translations: readonly TranslationRow[];
  includeRemoved?: boolean;
};

/** The admin listing: every catalogue row for `locale`, plus its plural expansions. */
export function buildEntries(input: EntriesInput): UiDictionaryEntry[] {
  const { locale } = input;
  const rows = input.includeRemoved
    ? input.catalogue
    : input.catalogue.filter((row) => !row.removedAt);
  const isEnglish = locale === DEFAULT_CONTENT_LOCALE;
  const translations = new Map(input.translations.map((row) => [row.key, row]));

  const entries: UiDictionaryEntry[] = rows.map((row) => {
    const translation = isEnglish ? undefined : translations.get(row.key);
    const status: EntryStatus = isEnglish
      ? row.overrideText === null
        ? 'source'
        : 'override'
      : translationStatus(row.effectiveHash, translation);
    return {
      key: row.key,
      locale,
      source: {
        text: row.text,
        overrideText: row.overrideText,
        effectiveText: effectiveText(row),
        effectiveHash: row.effectiveHash,
        description: row.description,
        maxLength: row.maxLength,
        pluralOf: row.pluralOf,
        pluralCategory: row.pluralOf ? splitPluralKey(row.key)?.category ?? null : null,
        expanded: false,
        removedAt: row.removedAt,
        overrideUpdatedBy: row.overrideUpdatedBy,
        overrideUpdatedAt: row.overrideUpdatedAt,
      },
      translation: toTranslation(translation),
      status,
    };
  });

  if (!isEnglish) {
    for (const expansion of pluralExpansions(rows, locale)) {
      const translation = translations.get(expansion.key);
      const { other } = expansion;
      entries.push({
        key: expansion.key,
        locale,
        source: {
          text: other.text,
          overrideText: other.overrideText,
          effectiveText: effectiveText(other),
          effectiveHash: other.effectiveHash,
          description: other.description,
          maxLength: other.maxLength,
          pluralOf: expansion.base,
          pluralCategory: expansion.category,
          expanded: true,
          removedAt: null,
          overrideUpdatedBy: other.overrideUpdatedBy,
          overrideUpdatedAt: other.overrideUpdatedAt,
        },
        translation: toTranslation(translation),
        status: translationStatus(other.effectiveHash, translation),
      });
    }
  }
  return entries.sort(byKey);
}

export type PendingInput = {
  locale: string;
  catalogue: readonly CatalogueRow[];
  translations: readonly TranslationRow[];
  force: boolean;
};

/** The translation job's work list for `locale` (never English). */
export function selectPendingLeaves(input: PendingInput): UiDictionaryPendingLeaf[] {
  const { locale, force } = input;
  const live = input.catalogue.filter((row) => !row.removedAt);
  const translations = new Map(input.translations.map((row) => [row.key, row]));
  const leaves: UiDictionaryPendingLeaf[] = [];

  for (const row of live) {
    if (!isPendingTranslation(row.effectiveHash, translations.get(row.key), force)) {
      continue;
    }
    const category = row.pluralOf ? splitPluralKey(row.key)?.category : undefined;
    leaves.push({
      key: row.key,
      text: effectiveText(row),
      sourceHash: row.effectiveHash,
      maxLength: row.maxLength,
      description: row.description,
      note: category ? pluralNote(locale, category) : null,
    });
  }
  for (const expansion of pluralExpansions(live, locale)) {
    const { other } = expansion;
    if (!isPendingTranslation(other.effectiveHash, translations.get(expansion.key), force)) {
      continue;
    }
    leaves.push({
      key: expansion.key,
      text: effectiveText(other),
      sourceHash: other.effectiveHash,
      maxLength: other.maxLength,
      description: other.description,
      note: pluralNote(locale, expansion.category),
    });
  }
  return leaves.sort(byKey);
}
