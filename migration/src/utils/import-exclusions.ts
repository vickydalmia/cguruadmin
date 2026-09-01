import fs from "node:fs";
import path from "node:path";
import { migrationRoot, profileFile } from "./profile-state.js";

// Terms excluded from the WordPress import, for three independent reasons:
//
//   1. The ARTICLES category — the term with slug "articles" / name
//      "Articles" (and every descendant term under it) holds editorial blog
//      content, not catalog entities. A `choose_type` of Article(s) is also
//      honored as a belt-and-braces signal.
//   2. UNCATEGORIZED — WordPress's fallback category is not a real catalog
//      entity, and every post still filed under it is incomplete source data.
//   3. OPTIONAL LISTED STORES — when MIGRATION_EXCLUSIONS_FILE is configured,
//      it names stores that source has retired; the store and everything filed
//      under it must not reach the new catalog.
//
// In all cases phase 03 skips the term and phases 07/08 skip (and, via the
// inventory reconciliation, converge away) every post filed under it; phase
// 10's expected counts apply the same rule.
//
// Config-free module top (the format-gaps.ts precedent): classifiers and the
// CSV parser are pure, and the WP lookup imports wp-client lazily so the test
// suite can load this file without .env.migration.

const ARTICLE_SLUG = "articles";
const ARTICLE_CHOOSE_TYPES = new Set(["article", "articles"]);
const UNCATEGORIZED_SLUG = "uncategorized";

export function isArticleChooseType(value: string | null | undefined): boolean {
  return ARTICLE_CHOOSE_TYPES.has((value ?? "").trim().toLowerCase());
}

export interface TermRowLike {
  term_id: number;
  name: string;
  slug: string;
  parent: number;
  choose_type: string | null;
}

/**
 * The Articles term itself: exact slug "articles" or exact name "Articles"
 * (case-insensitive), or an Article(s) choose_type.
 */
export function isArticleRootTerm(term: TermRowLike): boolean {
  return (
    term.slug.trim().toLowerCase() === ARTICLE_SLUG ||
    term.name.trim().toLowerCase() === ARTICLE_SLUG ||
    isArticleChooseType(term.choose_type)
  );
}

/** Article roots plus every descendant term under them. */
export function collectArticleTermIds(
  terms: readonly TermRowLike[],
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const term of terms) {
    if (!term.parent) continue;
    const siblings = childrenByParent.get(term.parent) ?? [];
    siblings.push(term.term_id);
    childrenByParent.set(term.parent, siblings);
  }
  const articleIds = new Set<number>();
  const queue = terms
    .filter((term) => isArticleRootTerm(term))
    .map((term) => term.term_id);
  while (queue.length > 0) {
    const termId = queue.pop()!;
    if (articleIds.has(termId)) continue;
    articleIds.add(termId);
    queue.push(...(childrenByParent.get(termId) ?? []));
  }
  return articleIds;
}

/** WordPress's exact fallback category (case-insensitive name or slug). */
export function isUncategorizedTerm(term: TermRowLike): boolean {
  return (
    term.slug.trim().toLowerCase() === UNCATEGORIZED_SLUG ||
    term.name.trim().toLowerCase() === UNCATEGORIZED_SLUG
  );
}

/** Store choose_type values the excluded-stores list may match (missing → Store). */
function isStoreChooseType(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "store";
}

/**
 * Case/whitespace-insensitive name key for excluded-store matching. Also folds
 * typographic characters to ASCII: the exclusion list originates from an Excel
 * sheet whose autocorrect curls apostrophes (U+2019) and substitutes × (U+00D7),
 * while `wp_terms.name` holds the ASCII forms — without folding, those rows
 * silently match nothing and the store imports anyway.
 */
export function normalizeStoreName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’‚ʼ]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/×/g, "x")
    .replace(/[–—]/g, "-")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Parse the exclusion CSV: one name per line, '#' comments, deduplicated. */
export function parseExcludedStoreNames(csv: string): Set<string> {
  const names = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    names.add(normalizeStoreName(value));
  }
  return names;
}

export function excludedStoresFile(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.MIGRATION_EXCLUSIONS_FILE?.trim();
  if (explicit) return path.resolve(migrationRoot(), explicit);
  return profileFile("excluded-stores.csv", environment);
}

export function loadExcludedStoreNames(): Set<string> {
  const file = excludedStoresFile();
  if (!fs.existsSync(file)) return new Set();
  return parseExcludedStoreNames(fs.readFileSync(file, "utf8"));
}

export interface ImportExclusions {
  /** Union of every excluded term id — what the phases consume. */
  termIds: Set<number>;
  articleTermIds: Set<number>;
  uncategorizedTermIds: Set<number>;
  excludedStoreTermIds: Set<number>;
  /** Listed names that matched no WP store term (review these). */
  unmatchedStoreNames: string[];
}

/** Pure resolution over a term list — the WP-connected wrapper is below. */
export function resolveImportExclusions(
  terms: readonly TermRowLike[],
  excludedNames: ReadonlySet<string>,
): ImportExclusions {
  const articleTermIds = collectArticleTermIds(terms);
  const uncategorizedTermIds = new Set(
    terms
      .filter((term) => isUncategorizedTerm(term))
      .map((term) => term.term_id),
  );
  const excludedStoreTermIds = new Set<number>();
  const matchedNames = new Set<string>();

  for (const term of terms) {
    if (
      articleTermIds.has(term.term_id) ||
      uncategorizedTermIds.has(term.term_id)
    ) {
      continue;
    }
    if (
      excludedNames.size > 0 &&
      isStoreChooseType(term.choose_type) &&
      excludedNames.has(normalizeStoreName(term.name))
    ) {
      excludedStoreTermIds.add(term.term_id);
      matchedNames.add(normalizeStoreName(term.name));
    }
  }

  return {
    termIds: new Set([
      ...articleTermIds,
      ...uncategorizedTermIds,
      ...excludedStoreTermIds,
    ]),
    articleTermIds,
    uncategorizedTermIds,
    excludedStoreTermIds,
    unmatchedStoreNames: [...excludedNames].filter(
      (name) => !matchedNames.has(name),
    ),
  };
}

let exclusionsPromise: Promise<ImportExclusions> | null = null;

/**
 * Resolve every excluded WP term id, cached per process. Listed-store
 * matching is restricted to terms whose choose_type is Store or missing, so
 * a Brand/Category/Bank sharing a name with a retired store is never
 * silently swallowed.
 */
export function getImportExclusions(): Promise<ImportExclusions> {
  if (exclusionsPromise) return exclusionsPromise;
  exclusionsPromise = (async () => {
    const { wpQuery } = await import("../db/wp-client.js");
    // RAW rows on purpose: the Excel classification canonicalizes every
    // choose_type to a catalog type, which would blind isArticleRootTerm's
    // Article(s) choose_type signal. Exclusions always read the source as-is.
    const sourceRows = await wpQuery<TermRowLike>(`
      SELECT t.term_id, t.name, t.slug, tt.parent,
             MAX(CASE WHEN tm.meta_key='choose_type' THEN tm.meta_value END) AS choose_type
      FROM wp_terms t
      JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'category'
      LEFT JOIN wp_termmeta tm ON t.term_id = tm.term_id AND tm.meta_key = 'choose_type'
      GROUP BY t.term_id, t.name, t.slug, tt.parent
    `);
    return resolveImportExclusions(sourceRows, loadExcludedStoreNames());
  })();
  return exclusionsPromise;
}

/** True when any of the post's category terms is excluded. */
export function hasExcludedTerm(
  termIds: readonly number[],
  excludedTermIds: ReadonlySet<number>,
): boolean {
  return termIds.some((termId) => excludedTermIds.has(termId));
}
