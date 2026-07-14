import assert from "node:assert/strict";
import test from "node:test";
import {
  limitHomepageBankOffers,
  MAX_HOMEPAGE_BANK_OFFERS,
} from "../src/utils/homepage-bank-offers.js";

test("homepage bank offers preserve rank and stop at the schema maximum", () => {
  const rankedOffers = Array.from({ length: 40 }, (_, index) => ({ rank: index + 1 }));

  const selected = limitHomepageBankOffers(rankedOffers);

  assert.equal(selected.length, MAX_HOMEPAGE_BANK_OFFERS);
  assert.deepEqual(
    selected.map(({ rank }) => rank),
    Array.from({ length: MAX_HOMEPAGE_BANK_OFFERS }, (_, index) => index + 1)
  );
});
