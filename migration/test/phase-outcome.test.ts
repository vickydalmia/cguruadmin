import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsPartialDeals,
  shouldCheckpointPhase,
} from "../src/utils/phase-outcome.js";

test("ordinary successful phases are checkpointed", () => {
  assert.equal(shouldCheckpointPhase(undefined), true);
  assert.equal(shouldCheckpointPhase({ checkpoint: true }), true);
});

test("soft partial phases continue without being checkpointed", () => {
  assert.equal(shouldCheckpointPhase({ checkpoint: false }), false);
});

test("partial Deal mode requires the explicit command-line flag", () => {
  assert.equal(allowsPartialDeals([]), false);
  assert.equal(allowsPartialDeals(["--allow-partial-deals"]), true);
  assert.equal(allowsPartialDeals(["--phase", "12-offer-backfill"]), false);
});
