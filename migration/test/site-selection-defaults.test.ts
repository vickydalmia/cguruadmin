import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADER_SEARCH_SUGGESTIONS,
  resolveLegacyPopularSearch,
  routeSlug,
  uniquePositiveIds,
} from "../src/utils/site-selection-defaults.js";

const catalogs = {
  store: new Map([["amazon", 1]]),
  brand: new Map([["nike", 2], ["shared", 20]]),
  category: new Map([["fashion", 3], ["shared", 30]]),
  bank: new Map([["hdfc", 4]]),
};

test("search overlay compatibility defaults retain the intended entries", () => {
  assert.deepEqual(HEADER_SEARCH_SUGGESTIONS, [
    { text: "Amazon Coupons", url: "/search/?q=Amazon" },
    { text: "Flipkart Offers", url: "/search/?q=Flipkart" },
    { text: "Myntra Coupons", url: "/search/?q=Myntra" },
    { text: "Today’s Deals", url: "/deal-of-the-day/" },
  ]);
});

test("legacy Popular Searches prefer explicit relations", () => {
  assert.deepEqual(
    resolveLegacyPopularSearch(
      { url: "/nike/", storeIds: [9], categoryIds: [8] },
      catalogs,
    ),
    { kind: "store", id: 9 },
  );
});

test("legacy URL-only links resolve only unambiguous canonical entities", () => {
  assert.deepEqual(
    resolveLegacyPopularSearch({ url: "/brands/nike/?x=1" }, catalogs),
    { kind: "brand", id: 2 },
  );
  assert.equal(
    resolveLegacyPopularSearch({ url: "/shared/" }, catalogs),
    null,
  );
  assert.equal(
    resolveLegacyPopularSearch({ url: "/deal-of-the-day/" }, catalogs),
    null,
  );
});

test("route and relation helpers normalize safely and preserve order", () => {
  assert.equal(routeSlug("https://www.couponzguru.com/stores/Amazon/"), "amazon");
  assert.equal(routeSlug("/too/many/parts/"), null);
  assert.deepEqual(uniquePositiveIds([2, 1, 2], [3, -1, 1]), [2, 1, 3]);
});
