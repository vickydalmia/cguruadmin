import assert from "node:assert/strict";
import test from "node:test";
import {
  extractOfferText,
  extractCashbackFields,
} from "../src/utils/offer-extract.js";

test("offerText: percentage off keeps the EXTRA qualifier", () => {
  assert.equal(
    extractOfferText("Snitch Fans Sale – Extra 18% (New Users) Off On Men's Fashion"),
    "EXTRA 18% OFF"
  );
});

test("offerText: flat rupee amount", () => {
  assert.equal(
    extractOfferText("Snitch New User Deal – Flat Rs.625 Off On Men's Clothing"),
    "FLAT ₹625 OFF"
  );
});

test("offerText: upto percentage", () => {
  assert.equal(extractOfferText("Get Upto 50% Off Sitewide"), "UPTO 50% OFF");
  assert.equal(extractOfferText("Grab up to 70% off"), "UPTO 70% OFF");
});

test("offerText: flat percentage", () => {
  assert.equal(extractOfferText("Flat 30% Off on Electronics"), "FLAT 30% OFF");
});

test("offerText: bare percentage has no qualifier word", () => {
  assert.equal(extractOfferText("Big Billion 40% Off"), "40% OFF");
});

test("offerText: rupee amount with off suffix", () => {
  assert.equal(extractOfferText("Save Rs.200 Off Your First Order"), "₹200 OFF");
});

test("offerText: bare FLAT when no amount", () => {
  assert.equal(extractOfferText("Flat Discount Bonanza"), "FLAT OFF");
});

test("offerText: never exceeds 3 words", () => {
  for (const t of [
    "Snitch Fans Sale – Extra 18% (New Users) Off On Men's Fashion",
    "Flat Rs.1,250 Off Sitewide Today",
    "Get Upto 50% Off Everything",
  ]) {
    const r = extractOfferText(t);
    assert.ok(r && r.split(/\s+/).length <= 3, `"${r}" should be <= 3 words`);
  }
});

test("offerText: falls back to content when title has nothing", () => {
  assert.equal(
    extractOfferText("Mega Sale Is Live", "<p>Enjoy 25% off on all orders</p>"),
    "25% OFF"
  );
});

test("offerText: null when nothing matches", () => {
  assert.equal(extractOfferText("Best Deals of the Season"), null);
  assert.equal(extractOfferText(null), null);
});

test("offerText: cashback percentage does not become the badge", () => {
  // Only "15% cashback" present — must NOT be read as a 15% OFF badge.
  assert.equal(extractOfferText("Pay via HDFC and get 15% Cashback"), null);
});

test("offerText: comma-grouped rupee amount is normalised to digits", () => {
  assert.equal(extractOfferText("Flat Rs.1,250 Off"), "FLAT ₹1250 OFF");
});

test("cashback fields: percentage cashback + bank off", () => {
  assert.deepEqual(
    extractCashbackFields("Extra 18% Off with 15% Cashback and 12% Bank Off"),
    { cashbackText: "15% Cashback", bankOfferText: "12% Bank OFF" }
  );
});

test("cashback fields: falls back to content and is case-insensitive", () => {
  assert.deepEqual(
    extractCashbackFields("15% Cashback offer", "Grab an extra 12% bank discount now"),
    { cashbackText: "15% Cashback", bankOfferText: "12% Bank OFF" }
  );
});

test("cashback fields: bare bank offer only when no percentage bank", () => {
  assert.deepEqual(extractCashbackFields("Exclusive Bank Offer inside"), {
    cashbackText: null,
    bankOfferText: "Bank OFF",
  });
  // With a % bank offer present, the bare fallback is suppressed.
  assert.deepEqual(
    extractCashbackFields("12% Bank Discount plus a Bank Offer"),
    { cashbackText: null, bankOfferText: "12% Bank OFF" }
  );
});

test("cashback fields: both null when none present", () => {
  assert.deepEqual(extractCashbackFields("Snitch Fans Sale – Extra 18% Off"), {
    cashbackText: null,
    bankOfferText: null,
  });
});

test("regex state does not leak across repeated calls", () => {
  // Guards against a module-level global regex retaining lastIndex.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(extractCashbackFields("Get 15% Cashback"), {
      cashbackText: "15% Cashback",
      bankOfferText: null,
    });
    assert.equal(extractOfferText("Flat 20% Off"), "FLAT 20% OFF");
  }
});
