import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  collectArticleTermIds,
  hasExcludedTerm,
  isArticleChooseType,
  isArticleRootTerm,
  isUncategorizedTerm,
  normalizeStoreName,
  parseExcludedStoreNames,
  resolveImportExclusions,
  type TermRowLike,
} from "../src/utils/import-exclusions.js";
import { applyTaxonomyClassification } from "../src/utils/taxonomy-classification.js";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");
const taxonomiesSource = read("../src/phases/03-taxonomies.ts");
const couponsSource = read("../src/phases/07-coupons.ts");
const dealsSource = read("../src/phases/08-deals.ts");
const verifySource = read("../src/phases/10-verify.ts");

function term(overrides: Partial<TermRowLike>): TermRowLike {
  return {
    term_id: 1,
    name: "Store X",
    slug: "store-x",
    parent: 0,
    choose_type: "Store",
    ...overrides,
  };
}

// The Articles category (exact name "Articles" / slug "articles") holds
// editorial content — the term, its descendants, and every post under them
// are excluded from the import.
test("article root matches the exact Articles name/slug plus choose_type", () => {
  assert.equal(isArticleRootTerm(term({ slug: "articles", name: "Whatever" })), true);
  assert.equal(isArticleRootTerm(term({ slug: "x", name: "Articles" })), true);
  assert.equal(isArticleRootTerm(term({ slug: "x", name: "articles " })), true);
  assert.equal(
    isArticleRootTerm(term({ choose_type: "Articles", slug: "x", name: "Y" })),
    true,
  );
  assert.equal(isArticleRootTerm(term({ slug: "article-hub", name: "Blog" })), false);
  assert.equal(isArticleChooseType("Store"), false);
});

test("article descendants are collected transitively", () => {
  const terms: TermRowLike[] = [
    term({ term_id: 10, name: "Articles", slug: "articles", choose_type: null }),
    term({ term_id: 11, name: "Guides", slug: "guides", parent: 10, choose_type: null }),
    term({ term_id: 12, name: "Deep", slug: "deep", parent: 11, choose_type: null }),
    term({ term_id: 20, name: "Amazon", slug: "amazon", parent: 0 }),
  ];
  assert.deepEqual([...collectArticleTermIds(terms)].sort(), [10, 11, 12]);
});

test("Uncategorized matches the exact fallback category only", () => {
  assert.equal(
    isUncategorizedTerm(term({ name: "Anything", slug: "Uncategorized " })),
    true,
  );
  assert.equal(
    isUncategorizedTerm(term({ name: " uncategorized", slug: "anything" })),
    true,
  );
  assert.equal(
    isUncategorizedTerm(term({ name: "Uncategorized Offers", slug: "offers" })),
    false,
  );
});

test("excluded-store CSV parsing normalizes and skips comments", () => {
  const names = parseExcludedStoreNames(
    "# comment\nJet  Airways \n\nYepme Shopping\njet airways\n",
  );
  assert.deepEqual([...names].sort(), ["jet airways", "yepme shopping"]);
  assert.equal(normalizeStoreName("  Jet   Airways "), "jet airways");
});

// The exclusion CSV came from an Excel sheet: autocorrect curled apostrophes
// and substituted × where wp_terms.name holds ' and x — both sides must fold
// to the same key or the listed store silently imports anyway.
test("store-name normalization folds typographic characters to ASCII", () => {
  assert.equal(normalizeStoreName("Banjara’s"), normalizeStoreName("Banjara's"));
  assert.equal(normalizeStoreName("Kohl‘s"), "kohl's");
  assert.equal(
    normalizeStoreName("Gifts To India 24×7"),
    normalizeStoreName("Gifts To India 24x7"),
  );
  assert.equal(normalizeStoreName("Firstcry – Baby Care"), "firstcry - baby care");
  assert.equal(normalizeStoreName("“Style” Store"), '"style" store');
  assert.equal(normalizeStoreName("Café Coffee’s"), "café coffee's");
});

test("resolveImportExclusions matches stores by name, store-typed terms only", () => {
  const terms: TermRowLike[] = [
    term({ term_id: 1, name: "Jet Airways", choose_type: "Store" }),
    term({ term_id: 2, name: "Yepme Shopping", choose_type: null }), // missing → Store
    term({ term_id: 3, name: "Jet Airways", choose_type: "Bank" }), // NOT swallowed
    term({ term_id: 4, name: "Articles", slug: "articles", choose_type: null }),
    term({ term_id: 5, name: "Amazon", choose_type: "Store" }),
    term({ term_id: 6, name: "Uncategorized", slug: "uncategorized", choose_type: null }),
  ];
  const exclusions = resolveImportExclusions(
    terms,
    new Set(["jet airways", "yepme shopping", "ghost store"]),
  );
  assert.deepEqual([...exclusions.excludedStoreTermIds].sort(), [1, 2]);
  assert.deepEqual([...exclusions.articleTermIds], [4]);
  assert.deepEqual([...exclusions.uncategorizedTermIds], [6]);
  assert.deepEqual([...exclusions.termIds].sort(), [1, 2, 4, 6]);
  // Names with no WP match are surfaced for review, not silently dropped.
  assert.deepEqual(exclusions.unmatchedStoreNames, ["ghost store"]);
});

test("hasExcludedTerm matches on any associated term", () => {
  const ids = new Set([7, 9]);
  assert.equal(hasExcludedTerm([1, 2, 9], ids), true);
  assert.equal(hasExcludedTerm([1, 2, 3], ids), false);
  assert.equal(hasExcludedTerm([], ids), false);
});

test("phase 03 skips excluded terms and reports all three kinds", () => {
  assert.match(taxonomiesSource, /classifyTaxonomyTerms\(sourceTerms\)/);
  // Exclusions must be resolved over the RAW rows: classification rewrites
  // an Article(s) choose_type to Store, which would defeat isArticleRootTerm.
  assert.match(taxonomiesSource, /resolveImportExclusions\(\s*sourceTerms,/);
  assert.match(taxonomiesSource, /exclusions\.articleTermIds\.has\(term\.term_id\)/);
  assert.match(taxonomiesSource, /exclusions\.uncategorizedTermIds\.has\(term\.term_id\)/);
  assert.match(taxonomiesSource, /exclusions\.excludedStoreTermIds\.has\(term\.term_id\)/);
  assert.match(taxonomiesSource, /counts\.Articles\+\+/);
  assert.match(taxonomiesSource, /counts\.Uncategorized\+\+/);
  assert.match(taxonomiesSource, /counts\.ExcludedStore\+\+/);
  assert.match(taxonomiesSource, /unmatchedStoreNames/);
  // Resume slug priming must mirror the skip or resumed runs drift.
  assert.match(
    taxonomiesSource,
    /\.filter\(\(term\) => !exclusions\.termIds\.has\(term\.term_id\)\)/,
  );
});

test("phases 07/08 exclude posts BEFORE inventory reconciliation", () => {
  for (const source of [couponsSource, dealsSource]) {
    assert.match(source, /getImportExclusions\(\)/);
    assert.match(source, /hasExcludedTerm\(/);
    // The exclusion must shape expectedDocumentIds so re-imports converge
    // previously imported excluded posts away.
    const excludeAt = source.indexOf("hasExcludedTerm(");
    const expectedAt = source.indexOf("const expectedDocumentIds");
    assert.ok(excludeAt >= 0 && expectedAt >= 0 && excludeAt < expectedAt);
    assert.match(source, /excluded post\(s\)/);
  }
});

test("phase 10 verify applies the same exclusion to expected counts", () => {
  assert.match(verifySource, /getImportExclusions\(\)/);
  assert.match(verifySource, /excludedTermIds/);
  // Same raw-rows rule as phase 03.
  assert.match(verifySource, /resolveImportExclusions\(\s*sourceTermRows,/);
});

// Regression: classification canonicalizes every choose_type to a catalog
// type, so exclusions computed AFTER it would import an Article-typed term
// (outside the articles slug tree) as a Store. Raw rows must feed exclusions.
test("an Article choose_type term stays excluded despite classification", () => {
  const rawTerms: TermRowLike[] = [
    term({ term_id: 1, name: "Buying Guides", slug: "buying-guides", choose_type: "Articles" }),
    term({ term_id: 2, name: "Amazon", slug: "amazon", choose_type: null }),
  ];
  const exclusions = resolveImportExclusions(rawTerms, new Set());
  assert.deepEqual([...exclusions.articleTermIds], [1]);
  // The same raw rows classified without a workbook would rewrite the
  // Article term to Store — which is exactly why exclusions must not read
  // the classified list.
  const { terms: classified } = applyTaxonomyClassification(rawTerms, null);
  assert.equal(classified[0].choose_type, "Store");
  assert.deepEqual(
    [...resolveImportExclusions(classified, new Set()).articleTermIds],
    [],
  );
});
