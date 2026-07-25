import assert from "node:assert/strict";
import test from "node:test";

import { staleMigratedOfferRows } from "../src/utils/offer-inventory.js";

test("removes only unexpected registry-owned offer rows", () => {
  const stale = staleMigratedOfferRows(
    [
      { id: 1, document_id: "abc123keep" },
      { id: 2, document_id: "abc123withdrawn" },
    ],
    new Set(["abc123keep"]),
  );

  assert.deepEqual(stale, [
    { id: 2, document_id: "abc123withdrawn" },
  ]);
});

test("an empty source inventory removes orphaned registry entries", () => {
  const stale = staleMigratedOfferRows(
    [
      { id: 1, document_id: "deleted-source" },
      { id: null, document_id: "already-missing-target" },
    ],
    new Set(),
  );

  assert.deepEqual(stale, [
    { id: 1, document_id: "deleted-source" },
    { id: null, document_id: "already-missing-target" },
  ]);
});
