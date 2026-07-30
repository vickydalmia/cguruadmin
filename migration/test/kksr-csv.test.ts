import assert from "node:assert/strict";
import test from "node:test";
import { combineKksrWithNewVotes, parseKksrCsv } from "../src/utils/kksr-csv.js";

const HEADER =
  "meta_id,taxonomy_id,taxonomy_name,taxonomy_slug,meta_key,meta_value";

test("parses complete ratings, BOM, quoted commas, and identical duplicates", () => {
  const ratings = parseKksrCsv(
    [
      `\uFEFF${HEADER}`,
      '10,38,"Shop, Inc.",shop,_kksr_avg,"4.20"',
      '11,38,"Shop, Inc.",shop,_kksr_casts,5',
      '12,38,"Shop, Inc.",shop,_kksr_ratings,21',
      '13,38,"Shop, Inc.",shop,_kksr_ratings,21',
    ].join("\r\n"),
  );
  assert.deepEqual(ratings, [
    {
      taxonomyId: 38,
      taxonomyName: "Shop, Inc.",
      taxonomySlug: "shop",
      average: 4.2,
      casts: 5,
      score: 21,
    },
  ]);
});

test("rejects incomplete and conflicting taxonomy aggregates", () => {
  assert.throws(
    () =>
      parseKksrCsv(
        [
          HEADER,
          "1,38,Shop,shop,_kksr_avg,4",
          "2,38,Shop,shop,_kksr_casts,1",
        ].join("\n"),
      ),
    /missing _kksr_ratings/,
  );
  assert.throws(
    () =>
      parseKksrCsv(
        [
          HEADER,
          "1,38,Shop,shop,_kksr_avg,4",
          "2,38,Shop,shop,_kksr_avg,5",
          "3,38,Shop,shop,_kksr_casts,1",
          "4,38,Shop,shop,_kksr_ratings,4",
        ].join("\n"),
      ),
    /conflicting _kksr_avg/,
  );
});

test("rejects an average that does not match accumulated score and casts", () => {
  assert.throws(
    () =>
      parseKksrCsv(
        [
          HEADER,
          "1,38,Shop,shop,_kksr_avg,5",
          "2,38,Shop,shop,_kksr_casts,2",
          "3,38,Shop,shop,_kksr_ratings,8",
        ].join("\n"),
      ),
    /does not match score\/casts/,
  );
});

test("combines recovered WordPress aggregates with post-cutover votes", () => {
  assert.deepEqual(combineKksrWithNewVotes({ casts: 5, score: 21 }, 2, 9), {
    ratingAverage: 4.29,
    ratingCount: 7,
  });
});
