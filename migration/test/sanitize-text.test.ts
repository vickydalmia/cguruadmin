import assert from "node:assert/strict";
import test from "node:test";

import { cleanHtml, cleanText } from "../src/utils/sanitize.js";

// The theme stored `store_short_description` as `<font size="2"><p>…` with
// neither tag closed (311 of 802 SG terms). It is rendered with `set:html`
// on the public site, so it must leave the importer balanced.
const LEGACY =
  '<font size= "2"><p>DH Gate is a huge marketplace. <h2>Latest DH Gate Coupon Codes</h2><font size= "2"><p>All that you need to save money.';

test("cleanHtml drops the legacy font wrapper and closes the open paragraphs", () => {
  assert.equal(
    cleanHtml(LEGACY),
    "<p>DH Gate is a huge marketplace. </p><h2>Latest DH Gate Coupon Codes</h2><p>All that you need to save money.</p>",
  );
});

test("cleanText reduces the same value to one line for meta descriptions", () => {
  assert.equal(
    cleanText(LEGACY),
    "DH Gate is a huge marketplace. Latest DH Gate Coupon Codes All that you need to save money.",
  );
});

test("cleanText decodes entities and collapses whitespace", () => {
  assert.equal(
    cleanText("<p>Tom &amp; Jerry&nbsp;&nbsp;<b>save</b>\n more</p>"),
    "Tom & Jerry save more",
  );
});

test("cleanText returns null for empty or tag-only input", () => {
  assert.equal(cleanText(null), null);
  assert.equal(cleanText("  "), null);
  assert.equal(cleanText("<p></p>"), null);
});
