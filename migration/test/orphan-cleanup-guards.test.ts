import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/cleanup-orphan-media.ts", import.meta.url),
  "utf8",
);
const indexSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);

// Orphan cleanup deletes from the live bucket; these guards are what stand
// between a misconfigured run and data loss. Config-bound module, so the
// guards are pinned source-contract style (the unique-code-migration.test.ts
// precedent); the shared key derivation itself is unit-tested in
// file-manifest.test.ts via referencedKeysFromRow.
test("orphan cleanup carries every safety guard", () => {
  // Empty rootPath would scope the scan to the whole bucket.
  assert.match(source, /refusing orphan cleanup over the whole bucket/i);
  // Empty DB / wrong connection string must not hollow out the bucket.
  assert.match(source, /rows\.length === 0 \|\| referenced\.size === 0/);
  // Mass-deletion fuse with an explicit override flag.
  assert.match(source, /MAX_ORPHAN_RATIO = 0\.4/);
  assert.match(source, /--force-orphan-cleanup/);
  // Bookkeeping prefix (manifest mirror) is never treated as an orphan.
  assert.match(source, /startsWith\(bookkeepingPrefix\)/);
  // Dry-run really is report-only.
  assert.match(source, /--dry-run: nothing deleted/);
  // Only deterministic manifest-owned rows may be pruned from the Media
  // Library; ordinary unlinked uploads remain outside this cleanup.
  assert.match(source, /findUnreferencedManifestFiles/);
  assert.match(source, /deleteUnreferencedManifestFiles/);
  assert.match(source, /restoredCandidateIds/);
  // Referenced set uses the SAME derivation as manifest reuse.
  assert.match(source, /referencedKeysFromRow/);
});

test("cleanup is wired as phase 16 and only after full success", () => {
  assert.match(indexSource, /16-orphan-media-cleanup/);
  assert.match(indexSource, /skipCheckpoint: true,\s*\},\s*\];/);
  // --delete-media clears the manifest alongside the bucket.
  assert.match(indexSource, /await clearFileManifest\(\)/);
});
