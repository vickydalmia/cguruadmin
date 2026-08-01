import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  couponLogoStoreCandidates,
  normalizeWpMediaPath,
} from "../src/utils/offer-logo-store.js";

const couponsSource = readFileSync(
  new URL("../src/phases/07-coupons.ts", import.meta.url),
  "utf8",
);
const dealsSource = readFileSync(
  new URL("../src/phases/08-deals.ts", import.meta.url),
  "utf8",
);

test("normalizes WordPress media URLs by upload path", () => {
  assert.equal(
    normalizeWpMediaPath("http://couponzguru.com/wp-content/uploads/Logo%20One.JPG?x=1"),
    "/wp-content/uploads/logo one.jpg",
  );
});

test("Coupon logo matching does not manufacture Store membership", () => {
  const index = new Map([
    ["/wp-content/uploads/cleartrip.jpg", [30]],
  ]);
  assert.deepEqual(
    couponLogoStoreCandidates(
      "https://www.couponzguru.com/wp-content/uploads/cleartrip.jpg",
      [99],
      index,
    ),
    [30],
  );
});

test("a related Store wins only as a duplicate-logo tie breaker", () => {
  const index = new Map([
    ["/wp-content/uploads/shared.jpg", [10, 20, 30]],
  ]);
  assert.deepEqual(
    couponLogoStoreCandidates(
      "https://www.couponzguru.com/wp-content/uploads/shared.jpg",
      [20],
      index,
    ),
    [20, 10, 30],
  );
});

test("Coupon and Deal migrations link Logo Store only without Store membership", () => {
  for (const source of [couponsSource, dealsSource]) {
    assert.match(
      source,
      /replaceOfferTaxonomyRelations\([\s\S]{0,500}logoStoreOnlyWithoutStore: true/,
    );
  }
});
