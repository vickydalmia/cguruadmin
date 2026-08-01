import assert from "node:assert/strict";
import test from "node:test";
import { archiveCandidateUploadName } from "../src/rebuild-file-manifest.js";

const HASH = "a".repeat(40) + "b".repeat(24); // 64 hex chars

// The transparent archive stores `${sourceSha256}.png` (permanent mode), but
// the upload that phase 02 folder-keys on was named `${sourceStem}-
// transparent.png`. Rebuild must recover that upload name or every archive
// candidate misses its S3 folder and reconstructs nothing (the pre-fix state:
// `transparent=0` on every run).
test("canonical archive names resolve the upload name via the source lookup", () => {
  const seen: string[] = [];
  const parsed = archiveCandidateUploadName(`${HASH}.png`, (hash16) => {
    seen.push(hash16);
    return "Apple iPhone 15.jpeg";
  });
  assert.deepEqual(parsed, {
    sourceHash: HASH,
    uploadFileName: "Apple iPhone 15-transparent.png",
  });
  // hashBuffer identity: sha256[0:16] of the same source bytes.
  assert.deepEqual(seen, [HASH.slice(0, 16)]);
});

test("legacy suffixed archive names use their embedded stem, no lookup", () => {
  const parsed = archiveCandidateUploadName(`${HASH}-my-photo.png`, () => {
    throw new Error("resolver must not be consulted for legacy names");
  });
  assert.deepEqual(parsed, {
    sourceHash: HASH,
    uploadFileName: "my-photo-transparent.png",
  });
});

test("canonical name with no local source is reported, not dropped silently", () => {
  assert.deepEqual(
    archiveCandidateUploadName(`${HASH}.png`, () => null),
    { sourceHash: HASH, uploadFileName: null },
  );
});

test("non-archive file names are ignored", () => {
  const resolver = () => "x.png";
  assert.equal(archiveCandidateUploadName("readme.txt", resolver), null);
  assert.equal(archiveCandidateUploadName(`${HASH.slice(0, 16)}.png`, resolver), null);
  assert.equal(
    archiveCandidateUploadName(`${HASH.toUpperCase()}.png`, resolver),
    null,
  );
  assert.equal(archiveCandidateUploadName(`${HASH}.webp`, resolver), null);
});
