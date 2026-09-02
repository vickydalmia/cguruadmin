import assert from "node:assert/strict";
import test from "node:test";
import {
  extractOfferCountries,
  loadProfileOfferCountries,
} from "../src/utils/offer-country-extract.js";

const ALL = "AE,SA,KW,BH,OM,QA,JO,TR,EG,GCC,GLOBAL,MENA";

test("extracts multiple explicit countries from title and HTML content in registry order", () => {
  assert.equal(
    extractOfferCountries(
      "Saudi Arabia and UAE offer",
      "<p>Also available in Kuwait &amp; Bahrain.</p>",
      ALL,
    ),
    "AE,SA,KW,BH",
  );
});

test("recognizes country adjectives, alternate spellings and regions", () => {
  assert.equal(
    extractOfferCountries(
      "Turkish and Egyptian collection for the GCC",
      "Available worldwide across M.E.N.A.",
      ALL,
    ),
    "TR,EG,GCC,GLOBAL,MENA",
  );
});

test("returns only countries enabled in the active site profile", () => {
  assert.equal(
    extractOfferCountries("UAE, KSA, Kuwait and Qatar", null, "AE,QA"),
    "AE,QA",
  );
  assert.equal(extractOfferCountries("UAE exclusive", null, ""), null);
});

test("avoids ambiguous ISO fragments, city inference and Global Village", () => {
  assert.equal(
    extractOfferCountries(
      "Woman's Jordan sneakers at Global Village Dubai",
      "SA savings with QA support",
      ALL,
    ),
    null,
  );
});

test("distinguishes geographic Jordan from the footwear brand", () => {
  assert.equal(
    extractOfferCountries(
      "Holiday packages",
      "Explore destinations like Egypt, Jordan and Türkiye.",
      ALL,
    ),
    "JO,TR,EG",
  );
  assert.equal(
    extractOfferCountries(
      "GCC & Jordan - Up to 70% off",
      null,
      ALL,
    ),
    "JO,GCC",
  );
  assert.equal(
    extractOfferCountries(
      "Shoes offer",
      "Brands listed: Nike, Jordan, Adidas and Puma.",
      ALL,
    ),
    null,
  );
});

test("global validity phrases do not mistake global artists for an offer region", () => {
  assert.equal(
    extractOfferCountries("Worldwide hotel bookings", null, ALL),
    "GLOBAL",
  );
  assert.equal(
    extractOfferCountries("Tickets for global artists", null, ALL),
    null,
  );
});

test("the UAE profile enables every registered offer-country option", () => {
  assert.equal(
    loadProfileOfferCountries(
      new URL("../profiles/ae/site-configuration.json", import.meta.url).pathname,
    ),
    ALL,
  );
});
