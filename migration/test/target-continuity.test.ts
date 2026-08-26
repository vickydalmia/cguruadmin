import assert from "node:assert/strict";
import test from "node:test";
import { hasStaleEmptyDealTarget } from "../src/utils/target-continuity.js";

test("Coupons-only profiles allow an empty source and target Deal inventory", () => {
  assert.equal(hasStaleEmptyDealTarget(0, 0), false);
});

test("an empty target still fails when importable source Deals exist", () => {
  assert.equal(hasStaleEmptyDealTarget(1, 0), true);
  assert.equal(hasStaleEmptyDealTarget(50, 0), true);
});

test("a populated Deal target satisfies the continuity guard", () => {
  assert.equal(hasStaleEmptyDealTarget(1, 1), false);
  assert.equal(hasStaleEmptyDealTarget(50, 40), false);
});
