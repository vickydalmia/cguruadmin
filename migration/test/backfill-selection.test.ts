import assert from "node:assert/strict";
import test from "node:test";
import { expectedFormatKeys } from "../src/utils/image-optimizer.js";
import {
  AVIF_DROPPED_META_KEY,
  buildAvifGapWhere,
  buildGapWhere,
  mergeAvifTombstones,
  missingAvifTwinKeys,
  readAvifTombstones,
} from "../src/utils/format-gaps.js";
import {
  parseLimitFlag,
  parseResumeFromTermFlag,
} from "../src/utils/cli.js";
import { mediaSourceResolution } from "../src/utils/media-source-candidates.js";
import {
  deduplicateSlug,
  primeSlugTracker,
  resetSlugTracker,
} from "../src/utils/slug-dedup.js";
import { resolveBackfillRemovalTimestamp } from "../src/utils/deal-image-backfill-state.js";

// Phase 15's candidate WHERE is GENERATED from IMAGE_BREAKPOINTS/THUMBNAIL —
// the same constants expectedFormatKeys derives from — so these drift guards
// are computed from the constants too: adding a breakpoint updates both the
// helper and the expected SQL automatically, which is exactly the contract.
// (Imports go through image-optimizer.js/format-gaps.js/cli.js only; all
// three are config-free so the suite runs without .env.migration.)

/** Disjuncts of the generated WHERE (arms are joined with newline + OR). */
function armsOf(sql: string): string[] {
  return sql.split(/\n\s*OR\s+/);
}

test("buildGapWhere covers every expected format key", () => {
  const { sql } = buildGapWhere(1);
  // A huge webp master nominates every possible key, twins included.
  for (const key of expectedFormatKeys(100000, 100000, "image/webp")) {
    assert.ok(sql.includes(`? '${key}'`), `no arm tests formats ? '${key}'`);
  }
});

test("every _avif arm carries the COALESCE'd tombstone guard", () => {
  const { sql } = buildGapWhere(1);
  const avifKeys = expectedFormatKeys(100000, 100000, "image/webp").filter(
    (key) => key.endsWith("_avif")
  );
  assert.ok(avifKeys.length > 0);
  for (const key of avifKeys) {
    const arm = armsOf(sql).find((candidate) =>
      candidate.includes(`(formats::jsonb ? '${key}')`)
    );
    assert.ok(arm, `no arm for ${key}`);
    assert.ok(
      arm.includes(
        `NOT COALESCE((provider_metadata::jsonb -> '${AVIF_DROPPED_META_KEY}') ? '${key}', false)`
      ),
      `arm for ${key} lacks the COALESCE'd tombstone guard (NULL ` +
        `provider_metadata would silently deselect provider rows)`
    );
    assert.ok(arm.includes("mime = 'image/webp'"), `arm for ${key} not webp-scoped`);
  }
});

test("the original_avif arm has no width/height condition", () => {
  const { sql } = buildGapWhere(1);
  const arm = armsOf(sql).find((candidate) =>
    candidate.includes(`(formats::jsonb ? 'original_avif')`)
  );
  assert.ok(arm, "no original_avif arm");
  assert.ok(!arm.includes("width"), "original_avif arm must not test width");
  assert.ok(!arm.includes("height"), "original_avif arm must not test height");
});

test("the NULL-dims arm exists", () => {
  const { sql } = buildGapWhere(1);
  assert.ok(sql.includes("(width IS NULL OR height IS NULL)"));
});

test("placeholders are dense, start at firstParamIndex and match params", () => {
  for (const first of [1, 5]) {
    const { sql, params } = buildGapWhere(first);
    const placeholders = new Set(
      [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    );
    assert.equal(params.length, placeholders.size);
    assert.equal(Math.min(...placeholders), first);
    assert.equal(Math.max(...placeholders), first + params.length - 1);
  }
});

test("readAvifTombstones tolerates every provider_metadata shape", () => {
  assert.deepEqual(readAvifTombstones(null), new Set());
  assert.deepEqual(readAvifTombstones({}), new Set());
  assert.deepEqual(readAvifTombstones({ key: "uploads/a.webp" }), new Set());
  assert.deepEqual(readAvifTombstones({ [AVIF_DROPPED_META_KEY]: "nope" }), new Set());
  assert.deepEqual(
    readAvifTombstones({ [AVIF_DROPPED_META_KEY]: ["a_avif", 7, "b_avif"] }),
    new Set(["a_avif", "b_avif"])
  );
});

test("mergeAvifTombstones unions sorted-unique into a copy of meta", () => {
  assert.deepEqual(mergeAvifTombstones(null, ["b_avif", "a_avif", "b_avif"]), {
    [AVIF_DROPPED_META_KEY]: ["a_avif", "b_avif"],
  });

  const meta = { key: "uploads/a.webp", [AVIF_DROPPED_META_KEY]: ["a_avif"] };
  const merged = mergeAvifTombstones(meta, ["b_avif", "a_avif"]);
  assert.deepEqual(merged, {
    key: "uploads/a.webp",
    [AVIF_DROPPED_META_KEY]: ["a_avif", "b_avif"],
  });
  // Input meta is never mutated.
  assert.deepEqual(meta, {
    key: "uploads/a.webp",
    [AVIF_DROPPED_META_KEY]: ["a_avif"],
  });
});

test("mergeAvifTombstones returns null when nothing new would be recorded", () => {
  assert.equal(mergeAvifTombstones(null, []), null);
  assert.equal(mergeAvifTombstones({ key: "uploads/a.webp" }, []), null);
  assert.equal(
    mergeAvifTombstones({ [AVIF_DROPPED_META_KEY]: ["a_avif", "b_avif"] }, ["a_avif"]),
    null
  );
});

test("phase 14 keeps failed responsive AVIF twins eligible after original drops", () => {
  const tombstoned = new Set(["original_avif"]);
  const formats = {
    small_avif: { url: "/small.avif" },
    large_avif: { url: "/large.avif" },
    xsmall_avif: { url: "/xsmall.avif" },
  };

  assert.deepEqual(
    missingAvifTwinKeys(formats, tombstoned, 1200, 800),
    ["medium_avif"],
  );

  const { sql } = buildAvifGapWhere(1);
  assert.ok(sql.includes("NOT (formats::jsonb ? 'medium_avif')"));
  assert.ok(sql.includes(`? 'original_avif', false)`));
  assert.ok(sql.includes(`? 'medium_avif', false)`));
});

test("metadata-less legacy S3 candidates remain distinct per file name", () => {
  const first = mediaSourceResolution(
    { name: "Hero One.jpg", hash: "shared", ext: ".jpg" },
    "uploads/",
  );
  const second = mediaSourceResolution(
    { name: "Hero Two.jpg", hash: "shared", ext: ".jpg" },
    "uploads/",
  );

  assert.equal(first.keyCandidates[0], second.keyCandidates[0]);
  assert.equal(first.keyCandidates[0], "uploads/shared.jpg");
  assert.notEqual(first.keyCandidates[1], second.keyCandidates[1]);
  assert.notEqual(first.groupKey, second.groupKey);
  assert.equal(first.keyCandidates[1], "uploads/shared_Hero One.jpg");
  assert.equal(second.keyCandidates[1], "uploads/shared_Hero Two.jpg");
});

test("taxonomy resume replays skipped slug collisions before the resumed row", () => {
  resetSlugTracker();
  primeSlugTracker([
    { slug: "shopping/amazon", table: "stores" },
    { slug: "shopping/amazon", table: "stores" },
  ]);

  assert.equal(
    deduplicateSlug("shopping/amazon", "stores"),
    "shopping/amazon-2",
  );
  assert.equal(
    deduplicateSlug("shopping/amazon", "brands"),
    "shopping/amazon",
  );
  resetSlugTracker();
});

test("deal-image timestamp is preserved only for archive-only S3 repair", () => {
  const previousRemovedAt = "2025-01-01T00:00:00.000Z";
  const processedAt = "2026-07-26T12:00:00.000Z";

  assert.equal(
    resolveBackfillRemovalTimestamp({
      repairMissingS3: true,
      reusedTransparentOutput: true,
      previousRemovedAt,
      processedAt,
    }),
    previousRemovedAt,
  );
  assert.equal(
    resolveBackfillRemovalTimestamp({
      repairMissingS3: false,
      reusedTransparentOutput: true,
      previousRemovedAt,
      processedAt,
    }),
    processedAt,
  );
  assert.equal(
    resolveBackfillRemovalTimestamp({
      repairMissingS3: true,
      reusedTransparentOutput: false,
      previousRemovedAt,
      processedAt,
    }),
    processedAt,
  );
});

test("parseLimitFlag accepts both --limit N and --limit=N", () => {
  assert.deepEqual(parseLimitFlag([]), { kind: "absent" });
  assert.deepEqual(parseLimitFlag(["--dry-run", "--overwrite"]), { kind: "absent" });
  assert.deepEqual(parseLimitFlag(["--limit", "50"]), { kind: "valid", value: 50 });
  assert.deepEqual(parseLimitFlag(["--limit=50"]), { kind: "valid", value: 50 });
  assert.deepEqual(parseLimitFlag(["--dry-run", "--limit", "25"]), {
    kind: "valid",
    value: 25,
  });
});

test("parseLimitFlag rejects every malformed shape", () => {
  const invalid: string[][] = [
    ["--limit"],
    ["--limit", "--overwrite"],
    ["--limit", "abc"],
    ["--limit="],
    ["--limit=abc"],
    ["--limit", "0"],
    ["--limit", "-5"],
    ["--limit=0"],
    ["--limit", "2.5"],
  ];
  for (const argv of invalid) {
    const parsed = parseLimitFlag(argv);
    assert.equal(parsed.kind, "invalid", argv.join(" "));
  }
});

test("parseLimitFlag inspects every occurrence", () => {
  // A malformed later occurrence must abort, not be shadowed by an earlier
  // valid one; among valid occurrences the first wins.
  assert.equal(parseLimitFlag(["--limit", "50", "--limit=abc"]).kind, "invalid");
  assert.equal(parseLimitFlag(["--limit=50", "--limit"]).kind, "invalid");
  assert.deepEqual(parseLimitFlag(["--limit=50", "--limit", "25"]), {
    kind: "valid",
    value: 50,
  });
});

test("parseResumeFromTermFlag accepts an inclusive positive term ID", () => {
  assert.deepEqual(parseResumeFromTermFlag([]), { kind: "absent" });
  assert.deepEqual(parseResumeFromTermFlag(["--resume-from-term", "4234"]), {
    kind: "valid",
    value: 4234,
  });
  assert.deepEqual(parseResumeFromTermFlag(["--resume-from-term=4234"]), {
    kind: "valid",
    value: 4234,
  });
});

test("parseResumeFromTermFlag rejects missing, malformed and duplicate values", () => {
  for (const argv of [
    ["--resume-from-term"],
    ["--resume-from-term", "--clean"],
    ["--resume-from-term=0"],
    ["--resume-from-term=-1"],
    ["--resume-from-term=abc"],
    ["--resume-from-term", "4234", "--resume-from-term=5000"],
  ]) {
    assert.equal(parseResumeFromTermFlag(argv).kind, "invalid");
  }
});
