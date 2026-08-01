import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  collectArticleTermIds,
  hasExcludedTerm,
  isArticleChooseType,
  isArticleRootTerm,
  normalizeStoreName,
  parseExcludedStoreNames,
  resolveImportExclusions,
  type TermRowLike,
} from "../src/utils/import-exclusions.js";

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
  ];
  const exclusions = resolveImportExclusions(
    terms,
    new Set(["jet airways", "yepme shopping", "ghost store"]),
  );
  assert.deepEqual([...exclusions.excludedStoreTermIds].sort(), [1, 2]);
  assert.deepEqual([...exclusions.articleTermIds], [4]);
  assert.deepEqual([...exclusions.termIds].sort(), [1, 2, 4]);
  // Names with no WP match are surfaced for review, not silently dropped.
  assert.deepEqual(exclusions.unmatchedStoreNames, ["ghost store"]);
});

test("hasExcludedTerm matches on any associated term", () => {
  const ids = new Set([7, 9]);
  assert.equal(hasExcludedTerm([1, 2, 9], ids), true);
  assert.equal(hasExcludedTerm([1, 2, 3], ids), false);
  assert.equal(hasExcludedTerm([], ids), false);
});

test("phase 03 skips excluded terms and reports both kinds", () => {
  assert.match(taxonomiesSource, /getImportExclusions\(\)/);
  assert.match(taxonomiesSource, /exclusions\.articleTermIds\.has\(term\.term_id\)/);
  assert.match(taxonomiesSource, /exclusions\.excludedStoreTermIds\.has\(term\.term_id\)/);
  assert.match(taxonomiesSource, /counts\.Articles\+\+/);
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
});
