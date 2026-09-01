import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanHtml,
  RICHTEXT_FIELDS,
  RICHTEXT_TARGETS,
} from "../src/utils/richtext-targets.js";
import { cleanHtml as migrationCleanHtml } from "../src/utils/sanitize.js";

// Both fix scripts (fix-markdown-richtext, fix-content-srcsets) iterate
// RICHTEXT_TARGETS; an unmapped uid must throw at module evaluation, so a
// successful import already proves every RICHTEXT_FIELDS uid has a table.

test("every richtext field maps to exactly one table/column target", () => {
  const expectedCount = Object.values(RICHTEXT_FIELDS).reduce(
    (sum, fields) => sum + fields.length,
    0
  );
  assert.ok(expectedCount > 0, "field registry must not be empty");
  assert.equal(RICHTEXT_TARGETS.length, expectedCount);

  const seen = new Set(
    RICHTEXT_TARGETS.map(({ table, column }) => `${table}.${column}`)
  );
  assert.equal(seen.size, RICHTEXT_TARGETS.length, "targets must be unique");
});

test("spot-checks the uid → table mapping", () => {
  assert.ok("api::store.store" in RICHTEXT_FIELDS);
  assert.deepEqual(RICHTEXT_FIELDS["api::store.store"], [
    "description",
    "festiveOfferDescription",
  ]);
  assert.ok(
    RICHTEXT_TARGETS.some(
      (target) => target.table === "stores" && target.column === "description"
    )
  );
  assert.ok(
    RICHTEXT_TARGETS.some(
      (target) => target.table === "deals" && target.column === "content"
    )
  );
  assert.ok(
    RICHTEXT_TARGETS.some(
      (target) =>
        target.table === "stores" &&
        target.column === "festiveOfferDescription",
    ),
  );
});

test("cleanHtml is the real main-package sanitizer, loaded across CJS/ESM", () => {
  assert.equal(cleanHtml("<script>alert(1)</script><p>ok</p>"), "<p>ok</p>");
});

test("migration sanitizer uses profile source and target hosts", () => {
  const sourceBefore = process.env.SOURCE_INTERNAL_HOSTS;
  const targetBefore = process.env.TARGET_INTERNAL_HOSTS;
  process.env.SOURCE_INTERNAL_HOSTS = "legacy.couponzguru.us";
  process.env.TARGET_INTERNAL_HOSTS = "www.couponzguru.us";
  try {
    assert.doesNotMatch(
      migrationCleanHtml('<a href="https://legacy.couponzguru.us/stores/">x</a>'),
      /nofollow/u,
    );
    assert.match(
      migrationCleanHtml('<a href="https://www.couponzguru.com/stores/">x</a>'),
      /nofollow/u,
    );
  } finally {
    if (sourceBefore === undefined) delete process.env.SOURCE_INTERNAL_HOSTS;
    else process.env.SOURCE_INTERNAL_HOSTS = sourceBefore;
    if (targetBefore === undefined) delete process.env.TARGET_INTERNAL_HOSTS;
    else process.env.TARGET_INTERNAL_HOSTS = targetBefore;
  }
});
