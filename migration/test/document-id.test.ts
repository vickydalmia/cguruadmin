import assert from "node:assert/strict";
import test from "node:test";

import { generateDocumentId } from "../src/utils/strapi-insert.js";

test("source-backed document IDs are deterministic and prefixless", () => {
  const first = generateDocumentId("coupon:123");
  const second = generateDocumentId("coupon:123");

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{24}$/);
  assert.equal(first.startsWith("wp_"), false);
});

test("different source types cannot collide on the same WordPress id", () => {
  assert.notEqual(
    generateDocumentId("coupon:123"),
    generateDocumentId("deal:123"),
  );
});
