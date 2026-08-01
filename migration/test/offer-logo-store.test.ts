import assert from "node:assert/strict";
import test from "node:test";
import {
  couponLogoStoreCandidates,
  normalizeWpMediaPath,
} from "../src/utils/offer-logo-store.js";

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
