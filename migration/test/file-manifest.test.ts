import assert from "node:assert/strict";
import test from "node:test";
import {
  decideMediaReuse,
  emptyFileManifest,
  manifestEntryFromRow,
  referencedKeysFromRow,
  type FileManifestEntry,
  type FilesRowLike,
} from "../src/utils/manifest-core.js";

const URL_PREFIX = "https://media.example.com";
const ROOT = "uploads/";

function folderRow(overrides: Partial<FilesRowLike> = {}): FilesRowLike {
  return {
    name: "photo.jpg",
    alternative_text: "A photo",
    caption: null,
    width: 1200,
    height: 800,
    formats: {
      small: {
        name: "small_photo.webp",
        hash: "small_photo",
        ext: ".webp",
        mime: "image/webp",
        path: null,
        width: 500,
        height: 333,
        size: 12.3,
        sizeInBytes: 12300,
        url: `${URL_PREFIX}/uploads/photo-a1b2c3d4/small_photo.webp`,
      },
    },
    ext: ".webp",
    mime: "image/webp",
    size: 45.6,
    hash: "a1b2c3d4e5f60718",
    url: `${URL_PREFIX}/uploads/photo-a1b2c3d4/photo.webp`,
    provider: "aws-s3",
    provider_metadata: { key: "uploads/photo-a1b2c3d4/photo.webp" },
    background_colour: "#ffffff",
    background_removal_source_hash: null,
    background_removal_version: null,
    background_removed_at: null,
    ...overrides,
  };
}

test("manifest entry round-trips through JSON with derived keys", () => {
  const entry = manifestEntryFromRow(folderRow(), URL_PREFIX, ROOT, "2026-08-01T00:00:00.000Z");
  assert.ok(entry);
  assert.deepEqual(entry.masterKeys, ["uploads/photo-a1b2c3d4/photo.webp"]);
  assert.deepEqual(entry.s3Keys, ["uploads/photo-a1b2c3d4/small_photo.webp"]);
  assert.equal(entry.sizeKb, 45.6);
  assert.equal(entry.backgroundRemoval, null);

  const manifest = emptyFileManifest(URL_PREFIX);
  manifest.entries["a1b2c3d4e5f60718"] = entry;
  const parsed = JSON.parse(JSON.stringify(manifest));
  assert.deepEqual(parsed, manifest);
});

test("legacy rows without a metadata key fall back to both flat candidates", () => {
  const entry = manifestEntryFromRow(
    folderRow({
      provider_metadata: null,
      formats: null,
      url: `${URL_PREFIX}/uploads/a1b2c3d4e5f60718.webp`,
    }),
    URL_PREFIX,
    ROOT,
    "2026-08-01T00:00:00.000Z",
  );
  assert.ok(entry);
  assert.deepEqual(entry.masterKeys, [
    "uploads/a1b2c3d4e5f60718.webp",
    "uploads/a1b2c3d4e5f60718_photo.webp",
  ]);
});

test("non-s3 rows and underivable formats produce no entry", () => {
  assert.equal(
    manifestEntryFromRow(folderRow({ provider: "local" }), URL_PREFIX, ROOT, "t"),
    null,
  );
  assert.equal(
    manifestEntryFromRow(
      folderRow({ formats: { small: { url: "https://elsewhere.example/x.webp" } } }),
      URL_PREFIX,
      ROOT,
      "t",
    ),
    null,
  );
});

test("background removal metadata is carried verbatim", () => {
  const entry = manifestEntryFromRow(
    folderRow({
      background_removal_source_hash: "f".repeat(64),
      background_removal_version: "fal-bria-rmbg-2.0-v1",
      background_removed_at: new Date("2026-07-29T10:00:00.000Z"),
    }),
    URL_PREFIX,
    ROOT,
    "t",
  );
  assert.ok(entry);
  assert.deepEqual(entry.backgroundRemoval, {
    sourceHash: "f".repeat(64),
    version: "fal-bria-rmbg-2.0-v1",
    removedAt: "2026-07-29T10:00:00.000Z",
  });
});

function reuseEntry(): FileManifestEntry {
  return manifestEntryFromRow(folderRow(), URL_PREFIX, ROOT, "t")!;
}

test("decideMediaReuse: DB row wins over everything", () => {
  assert.deepEqual(
    decideMediaReuse({ dbFileId: 7, manifestEntry: reuseEntry(), s3KeyIndex: new Set() }),
    { action: "db-skip" },
  );
});

test("decideMediaReuse: manifest hit requires every object present", () => {
  const entry = reuseEntry();
  const allKeys = new Set([
    "uploads/photo-a1b2c3d4/photo.webp",
    "uploads/photo-a1b2c3d4/small_photo.webp",
  ]);
  assert.deepEqual(decideMediaReuse({ manifestEntry: entry, s3KeyIndex: allKeys }), {
    action: "manifest-reuse",
    entry,
  });

  const missingVariant = decideMediaReuse({
    manifestEntry: entry,
    s3KeyIndex: new Set(["uploads/photo-a1b2c3d4/photo.webp"]),
  });
  assert.equal(missingVariant.action, "process");
  assert.deepEqual((missingVariant as any).missingKeys, [
    "uploads/photo-a1b2c3d4/small_photo.webp",
  ]);
});

test("decideMediaReuse: legacy master satisfied by ANY candidate", () => {
  const entry = manifestEntryFromRow(
    folderRow({
      provider_metadata: null,
      formats: null,
      url: `${URL_PREFIX}/uploads/a1b2c3d4e5f60718.webp`,
    }),
    URL_PREFIX,
    ROOT,
    "t",
  )!;
  assert.equal(
    decideMediaReuse({
      manifestEntry: entry,
      s3KeyIndex: new Set(["uploads/a1b2c3d4e5f60718_photo.webp"]),
    }).action,
    "manifest-reuse",
  );
});

test("decideMediaReuse: no manifest entry means process", () => {
  assert.deepEqual(decideMediaReuse({ s3KeyIndex: new Set() }), {
    action: "process",
  });
});

test("referencedKeysFromRow matches manifest derivation and is conservative", () => {
  assert.deepEqual(referencedKeysFromRow(folderRow(), URL_PREFIX, ROOT).sort(), [
    "uploads/photo-a1b2c3d4/photo.webp",
    "uploads/photo-a1b2c3d4/small_photo.webp",
  ]);
  // Legacy: both master candidates stay referenced — never orphan a key we
  // might be serving.
  assert.deepEqual(
    referencedKeysFromRow(
      folderRow({
        provider_metadata: null,
        formats: null,
        url: `${URL_PREFIX}/uploads/a1b2c3d4e5f60718.webp`,
      }),
      URL_PREFIX,
      ROOT,
    ).sort(),
    [
      "uploads/a1b2c3d4e5f60718.webp",
      "uploads/a1b2c3d4e5f60718_photo.webp",
    ],
  );
  assert.deepEqual(
    referencedKeysFromRow(folderRow({ provider: "local" }), URL_PREFIX, ROOT),
    [],
  );
});
