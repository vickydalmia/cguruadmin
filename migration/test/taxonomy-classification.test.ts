import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyTaxonomyClassification,
  loadTaxonomyClassificationWorkbook,
  parseTaxonomyClassificationRows,
  taxonomyClassificationFile,
} from "../src/utils/taxonomy-classification.js";

const WORKBOOK = fileURLToPath(
  new URL(
    "../usa/CouponzGuru_USA_Taxonomy_Classification (1).xlsx",
    import.meta.url,
  ),
);

test("classification rows require valid unique slugs and supported types", () => {
  const workbook = parseTaxonomyClassificationRows([
    ["Source Row", "Name", "Slug", "Classification"],
    ["2", "Amazon", "amazon-coupons", "Store"],
    ["3", "Nike", "nike-coupons", "brand"],
  ]);
  assert.equal(workbook.bySlug.get("amazon-coupons")?.classification, "Store");
  assert.equal(workbook.bySlug.get("nike-coupons")?.classification, "Brand");

  assert.throws(
    () =>
      parseTaxonomyClassificationRows([
        ["Name", "Slug", "Classification"],
        ["Nike", "nike-coupons", "Brand"],
        ["Nike duplicate", "NIKE-COUPONS", "Store"],
      ]),
    /duplicate slug 'nike-coupons'/,
  );
  assert.throws(
    () =>
      parseTaxonomyClassificationRows([
        ["Name", "Slug", "Classification"],
        ["Mystery", "mystery", "Merchant"],
      ]),
    /unsupported Classification 'Merchant'/,
  );
});

test("Excel classification is authoritative and unmatched SQL terms become Stores", () => {
  const workbook = parseTaxonomyClassificationRows([
    ["Name", "Slug", "Classification"],
    ["Nike", "nike-coupons", "Brand"],
    ["Old workbook row", "removed", "Category"],
  ]);
  const result = applyTaxonomyClassification(
    [
      { name: "Nike", slug: "NIKE-COUPONS", choose_type: null },
      { name: "New merchant", slug: "new-merchant", choose_type: "Bank" },
    ],
    workbook,
  );
  assert.deepEqual(
    result.terms.map(({ name, choose_type }) => [name, choose_type]),
    [
      ["Nike", "Brand"],
      ["New merchant", "Store"],
    ],
  );
  assert.equal(result.report.matchedSourceTerms, 1);
  assert.equal(result.report.fallbackSourceTerms, 1);
  assert.equal(result.report.unusedWorkbookRows, 1);
  assert.deepEqual(result.report.counts, {
    Store: 1,
    Brand: 1,
    Category: 0,
    Bank: 0,
  });
});

test("profiles without Excel retain choose_type with Store fallback", () => {
  const result = applyTaxonomyClassification(
    [
      { name: "Brand", slug: "brand", choose_type: "Brand" },
      { name: "Missing", slug: "missing", choose_type: null },
      { name: "Unknown", slug: "unknown", choose_type: "Unexpected" },
    ],
    null,
  );
  assert.deepEqual(
    result.terms.map(({ choose_type }) => choose_type),
    ["Brand", "Store", "Store"],
  );
});

test("the approved USA workbook keeps its audited classification totals", async () => {
  const workbook = await loadTaxonomyClassificationWorkbook(WORKBOOK);
  const counts = { Store: 0, Brand: 0, Category: 0, Bank: 0 };
  for (const row of workbook.rows) counts[row.classification]++;
  assert.equal(workbook.rows.length, 7_169);
  assert.deepEqual(counts, {
    Store: 542,
    Brand: 6_552,
    Category: 68,
    Bank: 7,
  });
});

test("USA and UAE default to their approved workbooks and India does not", () => {
  assert.equal(
    taxonomyClassificationFile({ MIGRATION_PROFILE: "usa" }),
    WORKBOOK,
  );
  assert.equal(
    taxonomyClassificationFile({ MIGRATION_PROFILE: "ae" }),
    fileURLToPath(
      new URL(
        "../uae/CouponzGuru_UAE_Taxonomy_Classification.xlsx",
        import.meta.url,
      ),
    ),
  );
  assert.equal(
    taxonomyClassificationFile({ MIGRATION_PROFILE: "india" }),
    null,
  );
});
