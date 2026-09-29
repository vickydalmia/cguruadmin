import assert from "node:assert/strict";
import test from "node:test";

import { structuralRepair, tagSignature } from "../src/utils/richtext-repair.js";
import { cleanHtml } from "../src/utils/richtext-targets.js";

const LEGACY =
  '<font size= "2"><p>DH Gate is a huge marketplace. <h2>Latest Codes</h2><font size= "2"><p>Save money.';

test("repairs the unclosed font/p wrapper the theme stored", () => {
  assert.equal(
    structuralRepair(LEGACY, cleanHtml),
    "<p>DH Gate is a huge marketplace. </p><h2>Latest Codes</h2><p>Save money.</p>",
  );
});

test("leaves a clean row alone even though entities would be normalized", () => {
  const clean = "<p><strong>Lazada</strong> is a marketplace&nbsp;in Singapore &amp; beyond.</p>";
  assert.equal(structuralRepair(clean, cleanHtml), null);
});

test("leaves an attribute-only difference for the next editor save", () => {
  assert.equal(structuralRepair('<p onclick="x()">text</p>', cleanHtml), null);
});

test("never blanks a value the allowlist reduces to nothing", () => {
  assert.equal(structuralRepair("<font></font>", cleanHtml), null);
});

test("tagSignature ignores case, attributes and text", () => {
  assert.equal(tagSignature('<P class="a">Hi <B>there</B></P>'), "<p <b </b </p");
});
