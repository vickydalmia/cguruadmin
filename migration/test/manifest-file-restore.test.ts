import assert from "node:assert/strict";
import test from "node:test";
import { manifestEntryToFilesRow } from "../src/utils/manifest-file-restore.js";
import type { FileManifestEntry } from "../src/utils/manifest-core.js";

function entry(): FileManifestEntry {
  return {
    name: "hero.webp",
    alternativeText: "Hero",
    caption: "Homepage hero",
    width: 1600,
    height: 900,
    formats: { small: { url: "https://cdn.test/uploads/small.webp" } },
    ext: ".webp",
    mime: "image/webp",
    sizeKb: 42.5,
    url: "https://cdn.test/uploads/hero.webp",
    providerMetadata: { key: "uploads/hero.webp" },
    backgroundColour: "#ffffff",
    backgroundRemoval: {
      sourceHash: "source-hash",
      version: "v1",
      removedAt: "2026-08-01T00:00:00.000Z",
    },
    masterKeys: ["uploads/hero.webp"],
    s3Keys: ["uploads/small.webp"],
    syncedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("manifest rows restore every files-table field without image processing", () => {
  const row = manifestEntryToFilesRow(
    "a1b2c3d4e5f60718",
    entry(),
    "2026-08-26T12:00:00.000Z",
  );

  assert.equal(row.hash, "a1b2c3d4e5f60718");
  assert.equal(row.provider, "aws-s3");
  assert.equal(row.folder_path, "/");
  assert.equal(row.alternative_text, "Hero");
  assert.equal(row.background_removal_source_hash, "source-hash");
  assert.equal(row.background_removal_version, "v1");
  assert.deepEqual(JSON.parse(row.formats!), entry().formats);
  assert.deepEqual(JSON.parse(row.provider_metadata), entry().providerMetadata);
  assert.equal(row.created_at, "2026-08-26T12:00:00.000Z");
  assert.equal(row.created_at, row.updated_at);
  assert.equal(row.created_at, row.published_at);
});

test("manifest file document ids are deterministic by content hash", () => {
  const first = manifestEntryToFilesRow("same-hash", entry(), "t1");
  const second = manifestEntryToFilesRow("same-hash", entry(), "t2");
  const other = manifestEntryToFilesRow("other-hash", entry(), "t1");

  assert.equal(first.document_id, second.document_id);
  assert.notEqual(first.document_id, other.document_id);
});

test("manifest ownership cannot collide across different content hashes", () => {
  const hashes = ["first", "second", "third"];
  const documentIds = hashes.map(
    (hash) => manifestEntryToFilesRow(hash, entry(), "t").document_id,
  );

  assert.equal(new Set(documentIds).size, hashes.length);
});
