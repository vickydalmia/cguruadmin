import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildOfferTaxonomyRelationBatchQuery } from "../src/utils/offer-relations.js";

const couponSource = readFileSync(
  new URL("../src/phases/07-coupons.ts", import.meta.url),
  "utf8",
);
const relationSource = readFileSync(
  new URL("../src/utils/offer-relations.ts", import.meta.url),
  "utf8",
);
test("Coupon preparation and database batches are independently bounded", () => {
  assert.match(couponSource, /pLimit\(preparationConcurrency\)/);
  assert.match(couponSource, /pLimit\(batchConcurrency\)/);
  assert.match(couponSource, /chunked\(posts, batchSize\)/);
  assert.doesNotMatch(couponSource, /pLimit\(20\)/);
});

test("Coupon target state safely guards empty media and pool work", () => {
  assert.match(couponSource, /async function loadCouponTargetState/);
  assert.match(couponSource, /AS has_content_media/);
  assert.match(couponSource, /AS has_unique_pool/);
  assert.match(
    couponSource,
    /coupon\.contentFileIds\.length > 0 \|\|[\s\S]*coupon\.targetState\?\.hasContentMedia/,
  );
  assert.match(
    couponSource,
    /coupon\.poolId !== null \|\|[\s\S]*coupon\.targetState\?\.hasUniquePool/,
  );
});

test("a Coupon batch commits all writes before updating memory mappings", () => {
  const transactionAt = couponSource.indexOf("return pgTransaction(async () =>");
  const upsertAt = couponSource.indexOf(
    "buildCouponUpsertBatchQuery",
    transactionAt,
  );
  const registryAt = couponSource.indexOf(
    "buildCouponRegistryBatchQuery",
    upsertAt,
  );
  const relationsAt = couponSource.indexOf(
    "await replaceResolvedOfferTaxonomyRelationBatch",
    registryAt,
  );
  const mappingAt = couponSource.indexOf(
    "setPostMapping(coupon.post.ID",
    relationsAt,
  );

  assert.ok(transactionAt >= 0);
  assert.ok(upsertAt > transactionAt);
  assert.ok(registryAt > upsertAt);
  assert.ok(relationsAt > registryAt);
  assert.ok(mappingAt > relationsAt, "memory mapping must happen after commit");
});

test("offer taxonomy reconciliation batches owners into one statement", () => {
  const query = buildOfferTaxonomyRelationBatchQuery("coupons", [
    {
      entityId: 77,
      resolved: {
        idsByTable: {
          stores: [9, 4],
          brands: [8],
          categories: [],
          banks: [2],
        },
        logoStoreId: 10,
      },
    },
    {
      entityId: 78,
      resolved: {
        idsByTable: {
          stores: [5],
          brands: [],
          categories: [],
          banks: [],
        },
        logoStoreId: null,
      },
    },
  ]);

  assert.deepEqual(query.params.slice(0, 4), [
    [77, 78],
    [77, 77, 78],
    [9, 4, 5],
    [1, 2, 1],
  ]);
  assert.equal(query.sql.match(/DELETE FROM/g)?.length, 5);
  assert.equal(query.sql.match(/INSERT INTO/g)?.length, 5);
  assert.match(query.sql, /WITH desired_stores/);
  assert.match(query.sql, /ON CONFLICT \("coupon_id", "store_id"\)/);
  assert.doesNotMatch(relationSource, /for \(let index = 0; index < ids\.length/);
});

test("Coupon progress reports throughput after every completed batch", () => {
  assert.match(couponSource, /completed \+= postBatch\.length/);
  assert.match(couponSource, /Coupon batch progress:/);
  assert.match(couponSource, /completed \/ elapsedSeconds/);
});

test("Coupon phase settles batch workers and delegates atomic failure isolation", () => {
  assert.match(couponSource, /persistBatchWithIsolation/);
  assert.match(couponSource, /Promise\.allSettled\(tasks\)/);
});
