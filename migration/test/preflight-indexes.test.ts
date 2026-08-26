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

test("source profile and count exceptions are validated before target mutation", () => {
  const profileValidation = preflightSource.indexOf(
    "validateSiteConfigurationProfile();",
  );
  const sourceValidation = preflightSource.indexOf(
    "await validateSourceDataExceptions();",
  );
  const firstTargetMutation = preflightSource.indexOf(
    "CREATE UNIQUE INDEX IF NOT EXISTS",
  );

  assert.ok(profileValidation >= 0, "profile validation must be called");
  assert.ok(sourceValidation >= 0, "source count validation must be called");
  assert.ok(firstTargetMutation >= 0, "target index mutation must remain explicit");
  assert.ok(profileValidation < sourceValidation);
  assert.ok(sourceValidation < firstTargetMutation);
});

test("attachment count drift is advisory while source validation stays before mutation", () => {
  const attachmentCheck = preflightSource.indexOf("Attachment count drift (non-blocking)");
  const storeCheck = preflightSource.indexOf("Store count exception");
  const attachmentBlockEnd = preflightSource.indexOf(
    "\n  const storeTerms",
    attachmentCheck,
  );

  assert.ok(attachmentCheck >= 0, "attachment drift warning must remain explicit");
  assert.ok(storeCheck > attachmentCheck, "hard Store validation must still follow it");
  assert.ok(attachmentBlockEnd > attachmentCheck);

  const attachmentBlock = preflightSource.slice(
    attachmentCheck - 300,
    attachmentBlockEnd,
  );
  assert.match(attachmentBlock, /logger\.warn\(/);
  assert.doesNotMatch(attachmentBlock, /throw new Error\(/);
  assert.match(preflightSource, /throw new Error\(\s*`Store count exception:/);
  assert.match(preflightSource, /throw new Error\(\s*`Deal count exception:/);
});
