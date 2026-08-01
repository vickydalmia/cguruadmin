import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  generateStrapiFormats,
  optimizeOriginal,
} from "../src/utils/image-optimizer.js";
import {
  fitInside,
  reconstructFormatsFromListing,
} from "../src/utils/manifest-core.js";

// THE parity safety net for manifest:rebuild. Reconstruction never decodes or
// encodes — dims come from pure fit-inside math and sizes from the S3
// listing — so this suite runs the REAL generator on sharp-built fixtures and
// asserts the reconstructed formats jsonb is byte-for-byte what phase 02
// would have stored. If a sharp upgrade ever shifts resize rounding, this
// fails loudly instead of the rebuild silently drifting by a pixel.

const URL_PREFIX = "https://media.example.com";

function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function makeOrientedJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/**
 * Run the real phase-02 pipeline (optimize + generate) for a source buffer,
 * then reconstruct from the resulting "bucket contents" and compare.
 */
async function assertParity(
  sourceBuffer: Buffer,
  sourceDims: { width: number; height: number },
  slug: string,
): Promise<void> {
  const optimized = await optimizeOriginal(sourceBuffer);
  assert.ok(optimized, "fixture should be optimizable");

  const keyPrefix = `uploads/${slug}-a1b2c3d4/`;
  const masterKey = `${keyPrefix}${slug}${optimized.ext}`;
  const generated = await generateStrapiFormats(optimized.buffer, {
    width: optimized.width,
    height: optimized.height,
    ext: optimized.ext,
    mime: optimized.mime,
    hashBase: slug,
    nameBase: slug,
    urlPrefix: URL_PREFIX,
    keyPrefix,
    avifSource: sourceBuffer,
  });

  // The "bucket": master + every uploaded variant with its real byte size.
  const sizesByKey = new Map<string, number>([
    [masterKey, optimized.sizeInBytes],
    ...generated.uploads.map(
      (upload): [string, number] => [upload.key, upload.buffer.length],
    ),
  ]);

  const reconstructed = reconstructFormatsFromListing({
    sourceWidth: sourceDims.width,
    sourceHeight: sourceDims.height,
    masterKey,
    masterExt: optimized.ext,
    masterMime: optimized.mime,
    masterSizeBytes: optimized.sizeInBytes,
    slug,
    keyPrefix,
    urlPrefix: URL_PREFIX,
    sizesByKey,
  });

  assert.deepEqual(reconstructed.ambiguous, []);
  assert.equal(reconstructed.width, optimized.width);
  assert.equal(reconstructed.height, optimized.height);
  assert.deepEqual(reconstructed.formatsJson, generated.formatsJson);
  assert.deepEqual(
    [...reconstructed.s3Keys].sort(),
    generated.uploads.map((upload) => upload.key).sort(),
  );
}

test("parity: large jpeg master (fit-inside-1920 resize, full tier set)", async () => {
  await assertParity(await makeJpeg(2400, 1200), { width: 2400, height: 1200 }, "large-img");
});

test("parity: small jpeg (thumbnail + partial tiers only)", async () => {
  await assertParity(await makeJpeg(400, 300), { width: 400, height: 300 }, "small-img");
});

test("parity: EXIF orientation 6 jpeg (portrait after rotation)", async () => {
  // Physical 800x400, displays as 400x800 — oriented source dims are what
  // the rebuild script feeds in (orientedSourceDims mirrors optimizeOriginal).
  await assertParity(
    await makeOrientedJpeg(800, 400),
    { width: 400, height: 800 },
    "oriented-img",
  );
});

test("non-optimized master reconstructs with formats null", () => {
  const keyPrefix = "uploads/anim-a1b2c3d4/";
  const masterKey = `${keyPrefix}anim.gif`;
  const result = reconstructFormatsFromListing({
    sourceWidth: 600,
    sourceHeight: 400,
    masterKey,
    masterExt: ".gif",
    masterMime: "image/gif",
    masterSizeBytes: 1234,
    slug: "anim",
    keyPrefix,
    urlPrefix: URL_PREFIX,
    sizesByKey: new Map([[masterKey, 1234]]),
  });
  assert.deepEqual(result.ambiguous, []);
  assert.equal(result.formatsJson, null);
  assert.equal(result.width, 600);
  assert.equal(result.height, 400);
});

test("missing webp variant is ambiguous; missing AVIF twin is omitted", async () => {
  const source = await makeJpeg(1600, 900);
  const optimized = (await optimizeOriginal(source))!;
  const keyPrefix = "uploads/gaps-a1b2c3d4/";
  const masterKey = `${keyPrefix}gaps${optimized.ext}`;
  const generated = await generateStrapiFormats(optimized.buffer, {
    width: optimized.width,
    height: optimized.height,
    ext: optimized.ext,
    mime: optimized.mime,
    hashBase: "gaps",
    nameBase: "gaps",
    urlPrefix: URL_PREFIX,
    keyPrefix,
    avifSource: source,
  });
  const sizesByKey = new Map<string, number>([
    [masterKey, optimized.sizeInBytes],
    ...generated.uploads.map(
      (upload): [string, number] => [upload.key, upload.buffer.length],
    ),
  ]);

  // Drop one AVIF twin — must be silently omitted (phase 14 pass 2 settles it).
  const avifKey = [...sizesByKey.keys()].find(
    (key) => key.endsWith(".avif") && key !== masterKey,
  );
  if (avifKey) {
    const withoutAvif = new Map(sizesByKey);
    withoutAvif.delete(avifKey);
    const result = reconstructFormatsFromListing({
      sourceWidth: 1600,
      sourceHeight: 900,
      masterKey,
      masterExt: optimized.ext,
      masterMime: optimized.mime,
      masterSizeBytes: optimized.sizeInBytes,
      slug: "gaps",
      keyPrefix,
      urlPrefix: URL_PREFIX,
      sizesByKey: withoutAvif,
    });
    assert.deepEqual(result.ambiguous, []);
    assert.ok(result.formatsJson);
  }

  // Drop a webp tier — must be ambiguous (the row would reference a 404).
  const webpVariant = [...sizesByKey.keys()].find(
    (key) => key !== masterKey && key.endsWith(".webp"),
  );
  assert.ok(webpVariant);
  const withoutWebp = new Map(sizesByKey);
  withoutWebp.delete(webpVariant);
  const broken = reconstructFormatsFromListing({
    sourceWidth: 1600,
    sourceHeight: 900,
    masterKey,
    masterExt: optimized.ext,
    masterMime: optimized.mime,
    masterSizeBytes: optimized.sizeInBytes,
    slug: "gaps",
    keyPrefix,
    urlPrefix: URL_PREFIX,
    sizesByKey: withoutWebp,
  });
  assert.ok(broken.ambiguous.length > 0);

  // An unexpected extra object is ambiguous too.
  const withExtra = new Map(sizesByKey);
  withExtra.set(`${keyPrefix}mystery.bin`, 10);
  const extra = reconstructFormatsFromListing({
    sourceWidth: 1600,
    sourceHeight: 900,
    masterKey,
    masterExt: optimized.ext,
    masterMime: optimized.mime,
    masterSizeBytes: optimized.sizeInBytes,
    slug: "gaps",
    keyPrefix,
    urlPrefix: URL_PREFIX,
    sizesByKey: withExtra,
  });
  assert.ok(extra.ambiguous.some((reason) => reason.includes("mystery.bin")));
});

test("fitInside mirrors sharp fit-inside semantics", () => {
  assert.deepEqual(fitInside(2400, 1200, 1920, 1920), { width: 1920, height: 960 });
  assert.deepEqual(fitInside(400, 300, 1920, 1920), { width: 400, height: 300 });
  assert.deepEqual(fitInside(2000, 100, 1000, 1000), { width: 1000, height: 50 });
  assert.deepEqual(fitInside(1200, 800, 245, 156), { width: 234, height: 156 });
});
