import assert from "node:assert/strict";
import test from "node:test";
import {
  auditTaxonomyDescriptionCoverage,
  isBlankTaxonomyDescription,
  parseTaxonomyDescriptionBackfillOptions,
  taxonomyDescriptionTarget,
  type StrapiTaxonomyDescriptionRow,
  type WpTaxonomyDescriptionRow,
} from "../src/utils/taxonomy-description-backfill.js";
import { generateDocumentId } from "../src/utils/strapi-insert.js";

function source(
  overrides: Partial<WpTaxonomyDescriptionRow> = {},
): WpTaxonomyDescriptionRow {
  return {
    term_id: 78,
    name: "Myntra",
    slug: "myntra-coupons",
    parent: 0,
    description: "<h2>Myntra coupons</h2><script>bad()</script>",
    choose_type: "Store",
    ...overrides,
  };
}

function target(
  overrides: Partial<StrapiTaxonomyDescriptionRow> = {},
): StrapiTaxonomyDescriptionRow {
  return {
    id: 6,
    document_id: generateDocumentId("term:stores:78"),
    name: "Myntra",
    description: null,
    table: "stores",
    ...overrides,
  };
}

test("taxonomy type mapping matches Phase 03 defaults", () => {
  assert.deepEqual(taxonomyDescriptionTarget("Brand"), {
    table: "brands",
    type: "api::brand.brand",
  });
  assert.deepEqual(taxonomyDescriptionTarget(null), {
    table: "stores",
    type: "api::store.store",
  });
  assert.deepEqual(taxonomyDescriptionTarget("Unexpected"), {
    table: "stores",
    type: "api::store.store",
  });
});

test("backfill is dry-run by default and requires the exact target confirmation", () => {
  assert.deepEqual(parseTaxonomyDescriptionBackfillOptions([], "beta-db"), {
    apply: false,
  });
  assert.throws(
    () => parseTaxonomyDescriptionBackfillOptions(["--apply"], "beta-db"),
    /Refusing to write to beta-db/,
  );
  assert.deepEqual(
    parseTaxonomyDescriptionBackfillOptions(
      ["--apply", "--yes-i-mean-beta-db"],
      "beta-db",
    ),
    { apply: true },
  );
  assert.throws(
    () =>
      parseTaxonomyDescriptionBackfillOptions(
        ["--apply", "--dry-run", "--yes-i-mean-beta-db"],
        "beta-db",
      ),
    /cannot be used together/,
  );
  assert.throws(
    () => parseTaxonomyDescriptionBackfillOptions(["--overwrite"], "beta-db"),
    /Unknown argument/,
  );
});

test("blank description detection accepts only meaningful strings", () => {
  assert.equal(isBlankTaxonomyDescription(null), true);
  assert.equal(isBlankTaxonomyDescription("  \n"), true);
  assert.equal(isBlankTaxonomyDescription("<p>Existing CMS copy</p>"), false);
});

test("audit selects a sanitized source description only when Strapi is blank", () => {
  const coverage = auditTaxonomyDescriptionCoverage([source()], [target()]);

  assert.equal(coverage.expected, 1);
  assert.equal(coverage.present, 0);
  assert.equal(coverage.gaps.length, 1);
  assert.deepEqual(
    {
      reason: coverage.gaps[0].reason,
      table: coverage.gaps[0].table,
      entityId: coverage.gaps[0].entityId,
      description: coverage.gaps[0].sanitizedDescription,
    },
    {
      reason: "blank-description",
      table: "stores",
      entityId: 6,
      description: "<h2>Myntra coupons</h2>",
    },
  );
});

test("audit preserves existing CMS content and ignores blank or excluded source", () => {
  const coverage = auditTaxonomyDescriptionCoverage(
    [
      source(),
      source({ term_id: 79, name: "Blank source", description: "  " }),
      source({ term_id: 80, name: "Excluded" }),
    ],
    [target({ description: "<p>Editor copy</p>" })],
    new Set([80]),
  );

  assert.deepEqual(coverage, { expected: 1, present: 1, gaps: [] });
});

test("audit reports a missing target separately from a blank description", () => {
  const coverage = auditTaxonomyDescriptionCoverage([source()], []);
  assert.equal(coverage.gaps[0].reason, "missing-entity");
  assert.equal(coverage.gaps[0].entityId, null);
});

test("audit follows the entity actually imported when WordPress type later changes", () => {
  const coverage = auditTaxonomyDescriptionCoverage(
    [source({ choose_type: "Category" })],
    [target({ description: "<p>Existing Store copy</p>" })],
  );
  assert.deepEqual(coverage, { expected: 1, present: 1, gaps: [] });
});
