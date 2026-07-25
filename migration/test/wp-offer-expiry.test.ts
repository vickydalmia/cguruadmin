import assert from "node:assert/strict";
import test from "node:test";

import { getWpOfferExpiryRaw } from "../src/utils/wp-offer-expiry.js";

test("Action Manager expiry has first precedence", () => {
  assert.equal(
    getWpOfferExpiryRaw({
      "_action_manager_date": "100",
      "_expiration-date": "200",
      "expiration-date": "300",
    }),
    "100",
  );
});

test("inactive expiration metadata is ignored", () => {
  assert.equal(
    getWpOfferExpiryRaw({
      "_expiration-date-status": "disabled",
      "_expiration-date": "200",
    }),
    undefined,
  );
});

test("saved expiration metadata falls back through both legacy keys", () => {
  assert.equal(
    getWpOfferExpiryRaw({
      "_expiration-date-status": "saved",
      "_expiration-date": "200",
      "expiration-date": "300",
    }),
    "200",
  );
  assert.equal(
    getWpOfferExpiryRaw({ "expiration-date": "300" }),
    "300",
  );
});
