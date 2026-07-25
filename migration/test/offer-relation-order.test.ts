import assert from "node:assert/strict";
import test from "node:test";
import { orderedUniqueTermIds } from "../src/utils/offer-relation-order.js";

test("Deal ownership order is ACF store, primary term, then stable WP terms", () => {
  assert.deepEqual(
    orderedUniqueTermIds({
      acfStoreTermId: 42,
      primaryTermId: 7,
      termIds: [9, 42, 7, 11],
    }),
    [42, 7, 9, 11],
  );
});

test("clearing or changing ACF ownership produces a complete replacement order", () => {
  const first = orderedUniqueTermIds({
    acfStoreTermId: 42,
    primaryTermId: 7,
    termIds: [7, 9],
  });
  const changed = orderedUniqueTermIds({
    acfStoreTermId: 55,
    primaryTermId: 7,
    termIds: [7, 9],
  });
  const cleared = orderedUniqueTermIds({
    acfStoreTermId: null,
    primaryTermId: 7,
    termIds: [7, 9],
  });

  assert.deepEqual(first, [42, 7, 9]);
  assert.deepEqual(changed, [55, 7, 9]);
  assert.deepEqual(cleared, [7, 9]);
  assert.deepEqual(
    orderedUniqueTermIds({
      acfStoreTermId: 55,
      primaryTermId: 7,
      termIds: [7, 9],
    }),
    changed,
  );
});
