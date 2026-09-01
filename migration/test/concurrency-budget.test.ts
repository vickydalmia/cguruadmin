import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateCouponConcurrency,
  allocateWorkerConcurrency,
} from "../src/utils/concurrency-budget.js";

test("an explicitly raised pool can run every requested Coupon worker", () => {
  const budget = allocateCouponConcurrency({
    poolMax: 14,
    requestedPreparation: 8,
    requestedBatches: 4,
    reserve: 2,
  });

  assert.deepEqual(budget, { preparation: 8, batches: 4, reserved: 2 });
  assert.ok(budget.preparation + budget.batches + budget.reserved <= 14);
});

test("the production-safe ten-connection pool reduces preparation", () => {
  const budget = allocateCouponConcurrency({
    poolMax: 10,
    requestedPreparation: 8,
    requestedBatches: 4,
    reserve: 2,
  });

  assert.deepEqual(budget, { preparation: 4, batches: 4, reserved: 2 });
});

test("small pools retain one preparation and one batch worker", () => {
  const budget = allocateCouponConcurrency({
    poolMax: 4,
    requestedPreparation: 8,
    requestedBatches: 4,
    reserve: 2,
  });

  assert.deepEqual(budget, { preparation: 1, batches: 1, reserved: 2 });
});

test("taxonomy workers also retain pool headroom", () => {
  assert.equal(
    allocateWorkerConcurrency({
      poolMax: 14,
      requested: 8,
      reserve: 2,
      maximum: 8,
    }),
    8,
  );
  assert.equal(
    allocateWorkerConcurrency({
      poolMax: 4,
      requested: 8,
      reserve: 2,
      maximum: 8,
    }),
    2,
  );
});
