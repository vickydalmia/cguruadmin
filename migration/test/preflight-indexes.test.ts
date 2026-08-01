import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const migration = require(
  "../../database/migrations/2026.07.29T00.00.00.add-deal-image-background-removal.js",
);
const preflightSource = readFileSync(
  new URL("../src/phases/00-preflight.ts", import.meta.url),
  "utf8",
);

// The background-removal dedup index is created by a Strapi migration that
// no-ops on fresh databases (files doesn't exist before schema sync) and is
// recorded forever, so preflight re-creates it from the SAME exported SQL —
// these tests guard both the wiring and drift between the two definitions.
test("migration exports the index definition preflight relies on", () => {
  assert.equal(migration.INDEX_NAME, "files_bg_removal_source_version_uq");
  assert.match(migration.indexSql, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(migration.indexSql, /"files_bg_removal_source_version_uq"/);
  assert.match(
    migration.indexSql,
    /"background_removal_source_hash", "background_removal_version"/,
  );
  assert.match(
    migration.indexSql,
    /WHERE "background_removal_source_hash" IS NOT NULL\s+AND "background_removal_version" IS NOT NULL/,
  );
  assert.equal(typeof migration.up, "function");
});

test("preflight requires the migration's SQL rather than duplicating it", () => {
  assert.match(
    preflightSource,
    /2026\.07\.29T00\.00\.00\.add-deal-image-background-removal\.js/,
  );
  assert.match(preflightSource, /bgRemovalIndexSql/);
  assert.match(preflightSource, /await pgQuery\(bgRemovalIndexSql\)/);
});
