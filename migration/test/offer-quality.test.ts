import assert from "node:assert/strict";
import test from "node:test";

import {
  corruptedNoCodeReason,
  isValidAffiliateDestination,
} from "../src/utils/offer-quality.js";

test("affiliate destinations require a safe absolute HTTP URL", () => {
  assert.equal(isValidAffiliateDestination("https://merchant.example/offer"), true);
  assert.equal(isValidAffiliateDestination("javascript:alert(1)"), false);
  assert.equal(isValidAffiliateDestination("/relative"), false);
  assert.equal(isValidAffiliateDestination(""), false);
});

test("URL and image values in Coupon code fields become reported no-code values", () => {
  assert.match(corruptedNoCodeReason("https://example.com/coupon.png") ?? "", /URL/u);
  assert.match(corruptedNoCodeReason("uploads/coupon.jpg") ?? "", /image/u);
  assert.equal(corruptedNoCodeReason("SAVE20"), null);
});
