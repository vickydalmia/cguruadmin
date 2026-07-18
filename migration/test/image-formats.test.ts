import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  BREAKPOINTS,
  IMAGE_BREAKPOINTS,
  decodeOrientedDims,
  expectedFormatKeys,
  formatTargets,
  generateAvifTwins,
  generateStrapiFormats,
  splitS3Key,
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

/** 800x400 physical jpeg carrying EXIF orientation 6 (displays as 400x800). */
function makeOrientedJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 400, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .withMetadata({ orientation: 6 })
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

test("expectedFormatKeys is a projection of formatTargets (same keys, same order)", () => {
  const cases: Array<[number, number, string]> = [
    [1600, 900, "image/webp"],
    [900, 1600, "image/webp"],
    [400, 300, "image/webp"],
    [400, 300, "image/png"],
    [300, 200, "image/jpeg"],
    [200, 100, "image/webp"],
    [200, 100, "image/png"],
    [245, 156, "image/png"],
    [321, 100, "image/png"],
    [100000, 100000, "image/webp"],
  ];
  for (const [width, height, mime] of cases) {
    assert.deepEqual(
      expectedFormatKeys(width, height, mime),
      formatTargets(width, height, mime).map((target) => target.key),
      `${width}x${height} ${mime}`
    );
  }
});

test("formatTargets pins filePrefix and bounding-box conventions", () => {
  const targets = formatTargets(1600, 900, "image/webp");
  const byKey = Object.fromEntries(targets.map((target) => [target.key, target]));
  assert.deepEqual(byKey.thumbnail, {
    key: "thumbnail", kind: "thumbnail", width: 245, height: 156, filePrefix: "thumbnail_",
  });
  assert.deepEqual(byKey.xsmall, {
    key: "xsmall", kind: "size", width: 320, height: 320, filePrefix: "xsmall_",
  });
  assert.deepEqual(byKey.xsmall_avif, {
    key: "xsmall_avif", kind: "avif", width: 320, height: 320, filePrefix: "xsmall_",
  });
  // original_avif has no filename prefix (the .avif ext already carries the
  // format) and boxes at the master's own dimensions.
  assert.deepEqual(byKey.original_avif, {
    key: "original_avif", kind: "avif", width: 1600, height: 900, filePrefix: "",
  });
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

test("EXIF orientation-6 jpeg master produces portrait variants", async () => {
  // Raw S3 masters (phase 15) may carry EXIF orientation; the tier resize
  // must bake it or portrait photos come out landscape.
  const master = await makeOrientedJpeg();
  const { formatsJson } = await generateStrapiFormats(master, {
    width: 400,
    height: 800,
    ...FORMAT_OPTS,
    ext: ".jpg",
    mime: "image/jpeg",
  });
  assert.equal(formatsJson.xsmall.width, 160);
  assert.equal(formatsJson.xsmall.height, 320);
  assert.equal(formatsJson.thumbnail.width, 78);
  assert.equal(formatsJson.thumbnail.height, 156);
});

test("no-EXIF master dims are unchanged by the orientation bake", async () => {
  // Phases 02/14 pass in re-encoded buffers with metadata stripped — the
  // orientation bake must be a no-op for them.
  const master = await makeWebp(800, 400);
  const { formatsJson } = await generateStrapiFormats(master, {
    width: 800,
    height: 400,
    ...FORMAT_OPTS,
  });
  assert.equal(formatsJson.xsmall.width, 320);
  assert.equal(formatsJson.xsmall.height, 160);
  assert.equal(formatsJson.small.width, 500);
  assert.equal(formatsJson.small.height, 250);
});

test("generateAvifTwins without compareTo emits every nominal twin", async () => {
  const master = await makeWebp(1600, 900);
  const { formatsJson, uploads, droppedKeys, droppedLarger } = await generateAvifTwins(master, {
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
  assert.deepEqual(droppedKeys, []);
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

test("generateAvifTwins lists guard-dropped twins in droppedKeys", async () => {
  const master = await makeWebp(1600, 900);
  const { formatsJson, droppedKeys, droppedLarger } = await generateAvifTwins(master, {
    width: 1600,
    height: 900,
    hashBase: "abc123_img",
    nameBase: "img",
    urlPrefix: "https://media.example.com",
    keyPrefix: "uploads/",
    // 1-byte counterparts force the size guard to drop exactly these twins.
    compareTo: { small_avif: 1, xsmall_avif: 1 },
  });
  assert.deepEqual(droppedKeys, ["small_avif", "xsmall_avif"]);
  assert.equal(droppedLarger, droppedKeys.length);
  assert.deepEqual(
    sorted(Object.keys(formatsJson)),
    sorted(["original_avif", "large_avif", "medium_avif"])
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
  const { formatsJson: kept, droppedAvifKeys: keptDropped } =
    await generateStrapiFormats(master, {
      width: 1600,
      height: 900,
      ...FORMAT_OPTS,
      onlyKeys: new Set(["xsmall_avif"]),
      existingSizes: { xsmall: 10_000_000 },
    });
  assert.deepEqual(Object.keys(kept), ["xsmall_avif"]);
  assert.deepEqual(keptDropped, []);

  // … and a smaller counterpart drops it (size guard).
  const { formatsJson: dropped, uploads, droppedAvifKeys } =
    await generateStrapiFormats(master, {
      width: 1600,
      height: 900,
      ...FORMAT_OPTS,
      onlyKeys: new Set(["xsmall_avif"]),
      existingSizes: { xsmall: 1 },
    });
  assert.deepEqual(dropped, {});
  assert.deepEqual(uploads, []);
  assert.deepEqual(droppedAvifKeys, ["xsmall_avif"]);
});

test("decodeOrientedDims returns oriented master dims with decoded=true", async () => {
  const oriented = await makeOrientedJpeg();
  assert.deepEqual(await decodeOrientedDims(oriented, null, null), {
    width: 400,
    height: 800,
    decoded: true,
  });
  // Undecodable bytes fall back to the provided values with decoded=false.
  const garbage = Buffer.from("definitely not an image");
  assert.deepEqual(await decodeOrientedDims(garbage, 640, 480), {
    width: 640,
    height: 480,
    decoded: false,
  });
  assert.deepEqual(await decodeOrientedDims(garbage, null, null), {
    width: null,
    height: null,
    decoded: false,
  });
});

test("splitS3Key derives keyPrefix/hashBase for folder, flat and root keys", () => {
  assert.deepEqual(splitS3Key("uploads/slug-ab12cd34/slug.webp", "uploads/"), {
    keyPrefix: "uploads/slug-ab12cd34/",
    hashBase: "slug",
  });
  assert.deepEqual(splitS3Key("uploads/a1b2c3d4_photo.webp", "uploads/"), {
    keyPrefix: "uploads/",
    hashBase: "a1b2c3d4_photo",
  });
  // Keys without a slash fall back to the root prefix.
  assert.deepEqual(splitS3Key("file.webp", "uploads/"), {
    keyPrefix: "uploads/",
    hashBase: "file",
  });
});
