// Plural handling. English pushes `base.one` / `base.other` (flagged with
// `pluralOf: base`); other languages need whatever CLDR says they need
// (Arabic: zero/one/two/few/many/other). The categories English never pushes
// are EXPANSION rows: not in `ui_catalogue`, translated from the base's
// `other` text, stored in `ui_translations` under `base.<category>`, and
// keyed to the `other` row's `effective_hash` for staleness. Pure.
import {
  isPluralCategory,
  PLURAL_CATEGORIES,
  type PluralCategory,
} from './constants';
import type { CatalogueRow } from './types';

export function pluralCategoriesFor(locale: string): PluralCategory[] {
  let categories: readonly string[];
  try {
    categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return ['other'];
  }
  const known = PLURAL_CATEGORIES.filter((category) =>
    categories.includes(category),
  );
  return known.length > 0 ? known : ['other'];
}

/** Smallest count that selects `category` in `locale`, for the translator's note. */
export function pluralExampleCount(
  locale: string,
  category: PluralCategory,
): number | null {
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    return null;
  }
  for (let count = 0; count <= 1_000; count += 1) {
    if (rules.select(count) === category) return count;
  }
  for (const count of [1_000_000, 1_000_000_000]) {
    if (rules.select(count) === category) return count;
  }
  return null;
}

export function pluralNote(locale: string, category: PluralCategory): string {
  const example = pluralExampleCount(locale, category);
  return example === null
    ? `plural form '${category}'`
    : `plural form '${category}' for a count like ${example}`;
}

/** `offers.count.few` → { base: 'offers.count', category: 'few' }; null otherwise. */
export function splitPluralKey(
  key: string,
): { base: string; category: PluralCategory } | null {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return null;
  const category = key.slice(dot + 1);
  if (!isPluralCategory(category)) return null;
  return { base: key.slice(0, dot), category };
}

export type PluralExpansion = {
  key: string;
  base: string;
  category: PluralCategory;
  /** The English `other` row the expansion is translated from. */
  other: CatalogueRow;
};

/**
 * The plural-category rows `locale` needs that English did not push, for
 * every LIVE plural base that pushed an `other` form.
 */
export function pluralExpansions(
  liveRows: readonly CatalogueRow[],
  locale: string,
): PluralExpansion[] {
  const pushed = new Map<string, Set<string>>();
  const others = new Map<string, CatalogueRow>();
  for (const row of liveRows) {
    if (!row.pluralOf || row.removedAt) continue;
    const split = splitPluralKey(row.key);
    if (!split || split.base !== row.pluralOf) continue;
    if (!pushed.has(row.pluralOf)) pushed.set(row.pluralOf, new Set());
    pushed.get(row.pluralOf)!.add(split.category);
    if (split.category === 'other') others.set(row.pluralOf, row);
  }
  const categories = pluralCategoriesFor(locale);
  const expansions: PluralExpansion[] = [];
  for (const [base, other] of others) {
    for (const category of categories) {
      if (pushed.get(base)?.has(category)) continue;
      expansions.push({ key: `${base}.${category}`, base, category, other });
    }
  }
  return expansions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type ResolvedSource = {
  /** The catalogue row the key's English source comes from. */
  row: CatalogueRow;
  /** Set when `key` is an expansion of `row` (which is the base's `other`). */
  expandedCategory: PluralCategory | null;
};

/**
 * Which live catalogue row a dictionary key translates from: the row itself,
 * or — for `base.<category>` keys English never pushed — the base's `other`
 * row. Null for unknown/removed keys. Does NOT check that the category is
 * one the locale uses (an imported extra category is harmless to serve).
 */
export function resolveSourceRow(
  liveByKey: ReadonlyMap<string, CatalogueRow>,
  key: string,
): ResolvedSource | null {
  const direct = liveByKey.get(key);
  if (direct) return { row: direct, expandedCategory: null };
  const split = splitPluralKey(key);
  if (!split) return null;
  const other = liveByKey.get(`${split.base}.other`);
  if (!other || other.pluralOf !== split.base) return null;
  return { row: other, expandedCategory: split.category };
}
