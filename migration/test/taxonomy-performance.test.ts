import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const taxonomySource = source("../src/phases/03-taxonomies.ts");
const mediaSource = source("../src/phases/02-media-upload.ts");
const manifestRestoreSource = source(
  "../src/utils/manifest-file-restore.ts",
);
const componentSource = source("../src/utils/strapi-insert.ts");
const configSource = source("../src/config.ts");

test("taxonomy workers use bounded concurrency and report every ten records", () => {
  assert.match(taxonomySource, /await runBoundedWork\(\{/);
  assert.match(taxonomySource, /items: prepared/);
  assert.match(taxonomySource, /concurrency,/);
  assert.match(taxonomySource, /completed % 10 === 0/);

  assert.match(configSource, /boundedInteger\("TAXONOMY_CONCURRENCY", 8, 1, 8\)/);
  assert.match(configSource, /allocateWorkerConcurrency/);
});

test("slug ownership is fixed before concurrent taxonomy workers start", () => {
  const prepareAt = taxonomySource.indexOf("deduplicateSlug(cleanSlug(term.slug)");
  const workersAt = taxonomySource.indexOf("await runBoundedWork({");

  assert.ok(prepareAt >= 0, "taxonomy slugs must be deduplicated");
  assert.ok(workersAt >= 0, "bounded workers must be configured");
  assert.ok(
    prepareAt < workersAt,
    "slug collision ownership must remain deterministic under concurrency",
  );
});

test("manifest-backed files rows are restored in bulk before cache preload", () => {
  assert.match(manifestRestoreSource, /INSERT INTO files[\s\S]*VALUES \$\{tuples\.join/);
  assert.match(manifestRestoreSource, /ON CONFLICT DO NOTHING/);

  const restoreAt = taxonomySource.indexOf("restoreManifestFileRows(s3KeyIndex)");
  const refreshAt = taxonomySource.indexOf("refreshFileRecordCache()");
  assert.ok(restoreAt >= 0 && refreshAt > restoreAt);
});

test("media records are preloaded once and concurrent equal bytes share work", () => {
  assert.match(
    mediaSource,
    /SELECT id, name, hash, ext, url, formats, width, height,[\s\S]*FROM files/,
  );
  assert.match(mediaSource, /const fileRecords = new Map/);
  assert.match(mediaSource, /const inFlightContentHashes = new Map/);
  assert.match(mediaSource, /inFlightContentHashes\.get\(hash\)/);
});

test("each taxonomy writes atomically after media resolution", () => {
  const assetResolutionAt = taxonomySource.indexOf(
    "const [descriptionMedia, fileId, ogFileId] = await Promise.all",
  );
  const transactionAt = taxonomySource.indexOf(
    "const entityId = await pgTransaction(async () =>",
  );

  assert.ok(assetResolutionAt >= 0 && transactionAt > assetResolutionAt);
  assert.match(
    taxonomySource,
    /pgTransaction\(async \(\) => \{[\s\S]*replaceMedia\([\s\S]*replaceContentMedia\([\s\S]*replaceComponents\(/,
  );
});

test("empty nested fields skip reads only when target state proves they are empty", () => {
  assert.match(
    taxonomySource,
    /descriptionMedia\.fileIds\.length > 0 \|\|[\s\S]*targetState\?\.hasDescriptionMedia/,
  );
  assert.match(
    taxonomySource,
    /faqItems\.length > 0 \|\| targetState\?\.hasFaq/,
  );
  assert.match(taxonomySource, /EXISTS \([\s\S]*has_description_media/);
  assert.match(taxonomySource, /EXISTS \([\s\S]*has_faq/);
});

test("component replacement does not repeat an already-resolved lookup", () => {
  assert.match(componentSource, /async function insertComponentWithoutLookup/);
  assert.match(
    componentSource,
    /const byOrder = new Map[\s\S]*if \(!currentId\) \{[\s\S]*insertComponentWithoutLookup/,
  );
});
