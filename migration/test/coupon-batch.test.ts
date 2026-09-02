import assert from "node:assert/strict";
import test from "node:test";
import {
  COUPON_INSERT_COLUMNS,
  buildCouponContentMediaBatchQueries,
  buildCouponPoolBatchQueries,
  buildCouponRegistryBatchQuery,
  buildCouponUpsertBatchQuery,
} from "../src/utils/coupon-batch.js";

function couponRow(seed: number): unknown[] {
  return COUPON_INSERT_COLUMNS.map((column) => `${column}-${seed}`);
}

test("Coupon upserts combine multiple records into one parameterized query", () => {
  const query = buildCouponUpsertBatchQuery([couponRow(1), couponRow(2)]);

  assert.equal(query.params.length, COUPON_INSERT_COLUMNS.length * 2);
  assert.match(query.sql, /VALUES \(\$1,/);
  assert.match(query.sql, /\(\$24,/);
  assert.match(
    query.sql,
    /ON CONFLICT \("document_id", "locale"\) DO UPDATE/,
  );
  assert.match(query.sql, /RETURNING id, document_id/);
});

test("Coupon upserts reject malformed rows before PostgreSQL is called", () => {
  assert.throws(
    () => buildCouponUpsertBatchQuery([["too-short"]]),
    /expected 23/,
  );
});

test("Coupon source registry rows share one upsert statement", () => {
  const query = buildCouponRegistryBatchQuery([
    { documentId: "coupon-a", sourceKey: "coupon:1" },
    { documentId: "coupon-b", sourceKey: "coupon:2" },
  ]);

  assert.deepEqual(query.params, [
    "coupon-a",
    "coupon:1",
    "coupons",
    "coupon-b",
    "coupon:2",
    "coupons",
  ]);
  assert.match(query.sql, /ON CONFLICT \("target_table", "source_key"\)/);
});

test("content-media reconciliation skips empty untouched Coupons and deduplicates files", () => {
  assert.deepEqual(
    buildCouponContentMediaBatchQueries([
      { entityId: 7, fileIds: [], reconcile: false },
    ]),
    [],
  );

  const queries = buildCouponContentMediaBatchQueries([
    { entityId: 7, fileIds: [1, 1, 2], reconcile: true },
    { entityId: 8, fileIds: [], reconcile: true },
  ]);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0]?.params, [[7, 8]]);
  assert.deepEqual(queries[1]?.params, [[1, 2], [7, 7], [1, 2]]);
});

test("unique-pool reconciliation skips untouched Coupons and batches desired pools", () => {
  assert.deepEqual(
    buildCouponPoolBatchQueries([
      { entityId: 7, poolId: null, reconcile: false },
    ]),
    [],
  );

  const queries = buildCouponPoolBatchQueries([
    { entityId: 7, poolId: 3, reconcile: true },
    { entityId: 8, poolId: null, reconcile: true },
  ]);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0]?.params, [[7, 8]]);
  assert.deepEqual(queries[1]?.params, [[7], [3]]);
});
