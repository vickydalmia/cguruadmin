import assert from "node:assert/strict";
import test from "node:test";

import { cleanDealContent } from "../src/utils/deal-content.js";

test("keeps descriptive Deal rich text", () => {
  assert.equal(
    cleanDealContent(
      "<ul><li>Save up to 40% on selected medicines.</li><li>No code is required.</li></ul>",
    ),
    "<ul><li>Save up to 40% on selected medicines.</li><li>No code is required.</li></ul>",
  );
  assert.equal(cleanDealContent("Limited stock."), "Limited stock.");
});

test("rejects legacy price and coupon-code values", () => {
  assert.equal(cleanDealContent("2,999"), null);
  assert.equal(cleanDealContent("7,350"), null);
  assert.equal(cleanDealContent("GURU5%"), null);
});

test("rejects empty rich-text wrappers", () => {
  assert.equal(cleanDealContent("<ul><li></li></ul>"), null);
  assert.equal(cleanDealContent("<blockquote>&nbsp;</blockquote>"), null);
  assert.equal(cleanDealContent("  "), null);
});
