import assert from "node:assert/strict";
import test from "node:test";
import {
  orderedUniqueTermIds,
  shouldLinkLogoStore,
} from "../src/utils/offer-relation-order.js";

test("offer membership keeps the stable WordPress taxonomy order", () => {
  assert.deepEqual(
    orderedUniqueTermIds({
      termIds: [9, 42, 7, 11],
    }),
    [9, 42, 7, 11],
  );
});

test("offer membership de-duplicates taxonomy terms without reordering", () => {
  assert.deepEqual(
    orderedUniqueTermIds({
      termIds: [7, 9, 7, 11, 9],
    }),
    [7, 9, 11],
  );
});

test("Coupon Logo Store is linked only when real Store membership is empty", () => {
  assert.equal(
    shouldLinkLogoStore({ onlyWithoutStore: true, storeIds: [101] }),
    false,
  );
  assert.equal(
    shouldLinkLogoStore({ onlyWithoutStore: true, storeIds: [] }),
    true,
  );
  assert.equal(
    shouldLinkLogoStore({ onlyWithoutStore: false, storeIds: [101] }),
    true,
  );
});
