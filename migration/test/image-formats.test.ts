import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  BREAKPOINTS,
  IMAGE_BREAKPOINTS,
  expectedFormatKeys,
  generateAvifTwins,
  generateStrapiFormats,
} from "../src/utils/image-optimizer.js";

// The migration once hardcoded its own breakpoint copy and silently dropped
// the xsmall(320) rung from the entire WordPress catalog. These tests pin the
// generator to the shared constants surface: exact variant matrices per
// master size, xsmall/xsmall_avif included, tiny masters producing nothing.
// (Constants are imported via image-optimizer.js, never straight from
// ../../src/constants/image.js — a static cross-package import of the CJS
// scope loses its named exports under tsx.)

const sorted = (keys: string[]) => [...keys].sort();
const nonAvif = (keys: string[]) => keys.filter((key) => !key.endsWith("_avif"));
const avifOnly = (keys: string[]) => keys.filter((key) => key.endsWith("_avif"));

/** Solid-color in-memory webp master (decodes fast, encodes deterministically). */
function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .webp({ quality: 80 })
    .toBuffer();
}

const FORMAT_OPTS = {
  ext: ".webp",
  mime: "image/webp",
  hashBase: "abc123_img",
  nameBase: "img",
  urlPrefix: "https://media.example.com",
  keyPrefix: "uploads/",
};

test("BREAKPOINTS deep-equals the shared IMAGE_BREAKPOINTS", () => {
  assert.deepEqual(BREAKPOINTS, { ...IMAGE_BREAKPOINTS });
  assert.ok("xsmall" in BREAKPOINTS, "xsmall rung must exist for small card slots");
});

test("expectedFormatKeys pins the exact variant matrix per master size", () => {
  // Breakpoint due when bp < width OR bp < height; thumbnail when the master
  // exceeds the 245x156 box; webp masters add original_avif + per-tier twins.
  assert.deepEqual(
    sorted(expectedFormatKeys(1600, 900, "image/webp")),
    sorted([
      "thumbnail", "large", "medium", "small", "xsmall",
      "original_avif", "large_avif", "medium_avif", "small_avif", "xsmall_avif",
    ])
  );
  assert.deepEqual(
    sorted(expectedFormatKeys(400, 300, "image/webp")),
    sorted(["thumbnail", "xsmall", "original_avif", "xsmall_avif"])
  );
  // Non-webp masters carry no AVIF twins.
  assert.deepEqual(
    sorted(expectedFormatKeys(400, 300, "image/png")),
    sorted(["thumbnail", "xsmall"])
  );
  assert.deepEqual(expectedFormatKeys(300, 200, "image/png"), ["thumbnail"]);
  assert.deepEqual(expectedFormatKeys(200, 100, "image/png"), []);
  // A tiny WEBP master still nominates original_avif (the size guard decides
  // at generation time whether the twin actually materializes).
  assert.deepEqual(expectedFormatKeys(200, 100, "image/webp"), ["original_avif"]);
  // Boundaries: must EXCEED the thumbnail box / the breakpoint to be due.
  assert.deepEqual(expectedFormatKeys(245, 156, "image/png"), []);
  assert.deepEqual(expectedFormatKeys(246, 156, "image/png"), ["thumbnail"]);
  assert.deepEqual(expectedFormatKeys(320, 320, "image/png"), ["thumbnail"]);
  assert.deepEqual(
    sorted(expectedFormatKeys(321, 100, "image/png")),
    sorted(["thumbnail", "xsmall"])
  );
});

test("1600x900 webp master gets every webp tier incl. xsmall", async () => {
  const master = await makeWebp(1600, 900);
  const { formatsJson, uploads } = await generateStrapiFormats(master, {
    width: 1600,
    height: 900,
    ...FORMAT_OPTS,
  });

  const keys = Object.keys(formatsJson);
  const expected = expectedFormatKeys(1600, 900, "image/webp");
  assert.deepEqual(sorted(nonAvif(keys)), sorted(nonAvif(expected)));
  // Twins generated in the same call are size-guarded against the fresh webp
  // tiers, so only subset membership is deterministic here; the unguarded
  // twin matrix is pinned in the generateAvifTwins test below.
  const nominalTwins = new Set(avifOnly(expected));
  for (const key of avifOnly(keys)) {
    assert.ok(nominalTwins.has(key), `unexpected twin key ${key}`);
  }
  // One upload per stored entry; key/url conventions hold.
  assert.equal(uploads.length, keys.length);
  assert.equal(
    formatsJson.xsmall.url,
    "https://media.example.com/uploads/xsmall_abc123_img.webp"
  );
  assert.equal(formatsJson.xsmall.width, 320);
  assert.equal(formatsJson.small.width, 500);
  assert.equal(formatsJson.medium.width, 750);
  assert.equal(formatsJson.large.width, 1000);
  assert.equal(formatsJson.thumbnail.width, 245);
});

test("400x300 master gets thumbnail + xsmall only", async () => {
  const master = await makeWebp(400, 300);
  const { formatsJson } = await generateStrapiFormats(master, {
    width: 400,
    height: 300,
    ...FORMAT_OPTS,
  });
  assert.deepEqual(sorted(nonAvif(Object.keys(formatsJson))), ["thumbnail", "xsmall"]);
  assert.equal(formatsJson.xsmall.width, 320);
});

test("300x200 master gets thumbnail only", async () => {
  const master = await makeWebp(300, 200);
  const { formatsJson } = await generateStrapiFormats(master, {
    width: 300,
    height: 200,
    ...FORMAT_OPTS,
  });
  assert.deepEqual(nonAvif(Object.keys(formatsJson)), ["thumbnail"]);
});

test("200x100 master gets no variants at all (non-webp master)", async () => {
  const master = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
  const { formatsJson, uploads } = await generateStrapiFormats(master, {
    width: 200,
    height: 100,
    ...FORMAT_OPTS,
    ext: ".png",
    mime: "image/png",
  });
  assert.deepEqual(formatsJson, {});
  assert.deepEqual(uploads, []);
});

test("generateAvifTwins without compareTo emits every nominal twin", async () => {
  const master = await makeWebp(1600, 900);
  const { formatsJson, uploads, droppedLarger } = await generateAvifTwins(master, {
    width: 1600,
    height: 900,
    hashBase: "abc123_img",
    nameBase: "img",
    urlPrefix: "https://media.example.com",
    keyPrefix: "uploads/",
  });
  assert.deepEqual(
    sorted(Object.keys(formatsJson)),
    sorted(["original_avif", "large_avif", "medium_avif", "small_avif", "xsmall_avif"])
  );
  assert.equal(droppedLarger, 0);
  assert.equal(uploads.length, 5);
  // Filenames drop the _avif suffix (the .avif ext already carries it).
  assert.equal(
    formatsJson.xsmall_avif.url,
    "https://media.example.com/uploads/xsmall_abc123_img.avif"
  );
  assert.equal(
    formatsJson.original_avif.url,
    "https://media.example.com/uploads/abc123_img.avif"
  );
});

test("onlyKeys + existingSizes drive the backfill path", async () => {
  const master = await makeWebp(1600, 900);

  // onlyKeys restricts generation to the requested tiers.
  const { formatsJson: restricted } = await generateStrapiFormats(master, {
    width: 1600,
    height: 900,
    ...FORMAT_OPTS,
    onlyKeys: new Set(["xsmall", "xsmall_avif"]),
  });
  assert.deepEqual(nonAvif(Object.keys(restricted)), ["xsmall"]);
  for (const key of Object.keys(restricted)) {
    assert.ok(["xsmall", "xsmall_avif"].includes(key), `unexpected key ${key}`);
  }

  // A twin-only backfill compares against existingSizes (bytes of the webp
  // tier uploaded by an earlier run): a huge counterpart keeps the twin …
  const { formatsJson: kept } = await generateStrapiFormats(master, {
    width: 1600,
    height: 900,
    ...FORMAT_OPTS,
    onlyKeys: new Set(["xsmall_avif"]),
    existingSizes: { xsmall: 10_000_000 },
  });
  assert.deepEqual(Object.keys(kept), ["xsmall_avif"]);

  // … and a smaller counterpart drops it (size guard).
  const { formatsJson: dropped, uploads } = await generateStrapiFormats(master, {
    width: 1600,
    height: 900,
    ...FORMAT_OPTS,
    onlyKeys: new Set(["xsmall_avif"]),
    existingSizes: { xsmall: 1 },
  });
  assert.deepEqual(dropped, {});
  assert.deepEqual(uploads, []);
});
