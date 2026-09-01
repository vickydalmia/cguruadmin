import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFER_RELATION_UNIQUE_INDEXES,
  relationUniqueIndexSql,
} from "../src/utils/relation-indexes.js";

test("preflight owns every conflict-target relation index", () => {
  const byTable = new Map(
    OFFER_RELATION_UNIQUE_INDEXES.map((spec) => [spec.table, spec.columns]),
  );

  assert.deepEqual(byTable.get("coupons_logo_store_lnk"), [
    "coupon_id",
    "store_id",
  ]);
  assert.deepEqual(byTable.get("coupons_unique_coupon_pool_lnk"), [
    "coupon_id",
    "unique_coupon_pool_id",
  ]);
  assert.deepEqual(byTable.get("deals_logo_store_lnk"), [
    "deal_id",
    "store_id",
  ]);
  assert.equal(byTable.size, 11);
});

test("relation index SQL exactly matches its ON CONFLICT pair", () => {
  const sql = relationUniqueIndexSql({
    table: "coupons_logo_store_lnk",
    columns: ["coupon_id", "store_id"],
  });

  assert.equal(
    sql,
    'CREATE UNIQUE INDEX IF NOT EXISTS "coupons_logo_store_lnk_uq" ' +
      'ON "coupons_logo_store_lnk" ("coupon_id", "store_id")',
  );
});
