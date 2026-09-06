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

test("offerText: bare 'flat' with no amount is NOT a badge", () => {
  // "Flat" alone (or modifying a price / cashback) must not become "FLAT OFF".
  assert.equal(extractOfferText("Flat Discount Bonanza"), null);
  assert.equal(extractOfferText("Men T-Shirts Flat At Rs.599"), null);
  assert.equal(extractOfferText("Plan Flat At $9.99/Month"), null);
});

test("offerText: bare rupee amount + off (no currency symbol)", () => {
  assert.equal(extractOfferText("Sign Up Offer - Flat 250 Off On 1st Purchase"), "FLAT ₹250 OFF");
  assert.equal(extractOfferText("Flat 1,000 Off On StartupHR Toolkit"), "FLAT ₹1000 OFF");
});

test("offerText: trailing-dollar amount + off", () => {
  assert.equal(extractOfferText("PDF Fusion - Flat 30$ Off On PDF Creator"), "FLAT $30 OFF");
  assert.equal(extractOfferText("Premium Sneakers - Flat 15$ Off On Adidas"), "FLAT $15 OFF");
});

test("offerText: scaled prize/credit sums are not discounts", () => {
  assert.equal(extractOfferText("Instant Credit Line Of Upto Rs.5 Lakh"), null);
  assert.equal(extractOfferText("IPL T20 Offer - Win Upto Rs.5 Crore Prizes"), null);
  assert.equal(extractOfferText("Trade & Win Upto Rs.1.3 Lakhs At Bitbns"), null);
});

test("offerText: a bare price (currency, no off) is not a discount", () => {
  assert.equal(extractOfferText("Enterprise Plan Flat At $99/Month"), null);
  assert.equal(extractOfferText("Green Coffee Flat At Just Rs.299"), null);
});

test("offerText: 'flat X% cashback' is cashback, not a FLAT discount", () => {
  assert.equal(extractOfferText("Flat 10% Cashback On Domestic Flights"), null);
});

test("cashback fields: 'Cashback Of X%' form is captured", () => {
  assert.deepEqual(extractCashbackFields("Gift Cards - Flat Cashback Of 10% In Wallet"), {
    cashbackText: "10%",
    bankOfferText: null,
    prepaidText: null,
  });
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
    { cashbackText: "15%", bankOfferText: "12%", prepaidText: null }
  );
});

test("cashback fields: falls back to content and is case-insensitive", () => {
  assert.deepEqual(
    extractCashbackFields("15% Cashback offer", "Grab an extra 12% bank discount now"),
    { cashbackText: "15%", bankOfferText: "12%", prepaidText: null }
  );
});

test("cashback fields: a bank offer without a number is ignored (no bare 'Bank OFF')", () => {
  assert.deepEqual(extractCashbackFields("Exclusive Bank Offer inside"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: null,
  });
});

test("cashback fields: percent bank with a bank name between", () => {
  assert.deepEqual(extractCashbackFields("Min 50% Off + Extra 10% HDFC Bank OFF"), {
    cashbackText: null,
    bankOfferText: "10%",
    prepaidText: null,
  });
});

test("cashback fields: rupee bank offer", () => {
  assert.deepEqual(
    extractCashbackFields("Up To 35% + Extra Up To Rs.2,000 Bank OFF"),
    { cashbackText: null, bankOfferText: "₹2000", prepaidText: null }
  );
});

test("cashback fields: dollar bank and prepaid offers retain USD", () => {
  assert.deepEqual(
    extractCashbackFields("$20 Bank Off and $5 Prepaid Discount", null, {
      currencyCode: "USD",
    }),
    { cashbackText: null, bankOfferText: "$20", prepaidText: "$5" },
  );
});

test("cashback fields: USA dollar cashback is captured in either word order", () => {
  const usa = { currencyCode: "USD" };
  assert.deepEqual(
    extractCashbackFields("Earn $25 Cashback today", null, usa),
    { cashbackText: "$25", bankOfferText: null, prepaidText: null },
  );
  assert.deepEqual(
    extractCashbackFields("Member reward: Cashback of $10", null, usa),
    { cashbackText: "$10", bankOfferText: null, prepaidText: null },
  );
  assert.deepEqual(
    extractCashbackFields("Member reward", "Receive Cashback USD 15", usa),
    { cashbackText: "$15", bankOfferText: null, prepaidText: null },
  );
  assert.deepEqual(
    extractCashbackFields("USD 15 CAshback", null, usa),
    { cashbackText: "$15", bankOfferText: null, prepaidText: null },
  );
  assert.deepEqual(
    extractCashbackFields("usd 15 cashback", null, usa),
    { cashbackText: "$15", bankOfferText: null, prepaidText: null },
  );
});

test("cashback fields: punctuation between Cashback and a dollar amount is accepted", () => {
  assert.deepEqual(
    extractCashbackFields("Cashback: $10", null, { currencyCode: "USD" }),
    { cashbackText: "$10", bankOfferText: null, prepaidText: null },
  );
  assert.deepEqual(
    extractCashbackFields("Cashback - USD 15", null, {
      currencyCode: "USD",
    }),
    { cashbackText: "$15", bankOfferText: null, prepaidText: null },
  );
});

test("cashback fields: explicit INR cashback remains INR in every profile", () => {
  assert.deepEqual(
    extractCashbackFields("Get Rs.100 Cashback", null, {
      currencyCode: "USD",
    }),
    { cashbackText: "₹100", bankOfferText: null, prepaidText: null },
  );
});

test("offerText: currency cashback does not become the main discount badge", () => {
  assert.equal(
    extractOfferText("Earn $25 Cashback today", null, { currencyCode: "USD" }),
    null,
  );
});

test("cashback fields: both null when none present", () => {
  assert.deepEqual(extractCashbackFields("Snitch Fans Sale – Extra 18% Off"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: null,
  });
});

test("offerText: MIN qualifier and ranges keep the first number", () => {
  assert.equal(extractOfferText("Biba - Min 35% Off On Ethnics"), "MIN 35% OFF");
  assert.equal(extractOfferText("Lavie - Min 30% To 80% Off"), "MIN 30% OFF");
  assert.equal(extractOfferText("End Of Season Sale - Flat 40-60% Off"), "FLAT 40% OFF");
  assert.equal(extractOfferText("Minimum 40% Off On Shoes"), "MIN 40% OFF");
});

test("offerText: Additional maps to EXTRA; Save is a discount", () => {
  assert.equal(extractOfferText("New User - Additional 10% Off"), "EXTRA 10% OFF");
  assert.equal(extractOfferText("Additional Rs.100 Off"), "EXTRA ₹100 OFF");
  assert.equal(extractOfferText("Save 55% On PrivateVPN Plan"), "55% OFF");
});

test("offerText: dollar amounts", () => {
  assert.equal(extractOfferText("Upto $20 Off On Flights"), "UPTO $20 OFF");
  assert.equal(extractOfferText("$40 Instant Off On Bookings"), "$40 OFF");
});

test("offerText: USA commerce phrases and locale-aware bare amounts", () => {
  assert.equal(extractOfferText("Free Shipping on every order"), "FREE SHIPPING");
  assert.equal(extractOfferText("Buy One Get One Free"), "BOGO");
  assert.equal(extractOfferText("Starting At $19 today"), "STARTING $19");
  assert.equal(extractOfferText("All gifts Under $25"), "UNDER $25");
  assert.equal(
    extractOfferText("Flat 25 Off", null, { currencyCode: "USD" }),
    "FLAT $25 OFF",
  );
});

test("offerText: Singapore dollar amounts keep the S$ marker", () => {
  const sg = { currencyCode: "SGD" };
  assert.equal(
    extractOfferText("Flight Bookings Starting At S$34", null, sg),
    "STARTING S$34",
  );
  assert.equal(extractOfferText("Gadgets Under S$100", null, sg), "UNDER S$100");
  assert.equal(
    extractOfferText("Flat S$25 Off On Sitewide Orders", null, sg),
    "FLAT S$25 OFF",
  );
  assert.equal(extractOfferText("S$10 Off Your First Order", null, sg), "S$10 OFF");
  assert.equal(extractOfferText("Save SGD 15 Off Bags", null, sg), "S$15 OFF");
  // Bare amount: the SG profile's default symbol, not the India rupee.
  assert.equal(extractOfferText("Flat 250 Off", null, sg), "FLAT S$250 OFF");
});

test("cashback fields: Singapore dollar cashback and bank offers", () => {
  assert.deepEqual(
    extractCashbackFields("S$10 Cashback + S$20 DBS Bank Off", null, {
      currencyCode: "SGD",
    }),
    { cashbackText: "S$10", bankOfferText: "S$20", prepaidText: null },
  );
});

test("offerText: US$ and letter-adjacent s$ still read as a plain dollar", () => {
  // UAE/India titles write "US$"; the S must not be mistaken for S$. (The
  // qualifier is lost here exactly as before this change: "US$" never matched
  // the qualifier-then-currency pattern.)
  assert.equal(extractOfferText("Upto US$20 Off Hotel Stays"), "$20 OFF");
  assert.equal(extractOfferText("US$10 Off Sitewide", null, { currencyCode: "AED" }), "$10 OFF");
  assert.equal(extractOfferText("Upto $20 Off"), "UPTO $20 OFF");
  assert.equal(extractOfferText("Flat 250 Off"), "FLAT ₹250 OFF");
  assert.equal(
    extractOfferText("Flat 25 Off", null, { currencyCode: "USD" }),
    "FLAT $25 OFF",
  );
});

test("offerText: a non-discount % is not a badge", () => {
  assert.equal(extractOfferText("100% Whey Protein"), null);
  assert.equal(extractOfferText("Welcome Bonus: 100% Match On Deposit"), null);
  assert.equal(extractOfferText("Mock Tests - 100% Free Exams"), null);
});

test("prepaid fields: percent prepaid off", () => {
  assert.deepEqual(extractCashbackFields("Flat 10% + Extra 5% Prepaid Off"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: "5%",
  });
});

test("prepaid fields: rupee prepaid discount", () => {
  assert.deepEqual(extractCashbackFields("Get Rs.100 Prepaid Discount On Orders"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: "₹100",
  });
});

test("prepaid fields: an amountless perk is NOT extracted (amount-only columns)", () => {
  // "Free shipping on prepaid" has no percent/rupee amount, and the benefit
  // columns store bare amounts only — nothing to extract.
  assert.deepEqual(extractCashbackFields("Free Shipping On Every Prepaid Order"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: null,
  });
});

test("prepaid fields: bare 'prepaid' without off/discount/offer extracts nothing", () => {
  assert.deepEqual(extractCashbackFields("Pay Prepaid For Faster Delivery"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: null,
  });
  assert.deepEqual(extractCashbackFields("Flat 25% Off On Prepaid Hotel Bookings"), {
    cashbackText: null,
    bankOfferText: null,
    prepaidText: null,
  });
});

test("prepaid fields: '10% Prepaid Bank Off' stays a bank offer", () => {
  assert.deepEqual(extractCashbackFields("Extra 10% Prepaid Bank Off"), {
    cashbackText: null,
    bankOfferText: "10%",
    prepaidText: null,
  });
});

test("offerText: prepaid span is stripped and never becomes the badge", () => {
  // "Extra 5% Prepaid Off" alone must not produce "EXTRA 5% OFF".
  assert.equal(extractOfferText("Extra 5% Prepaid Off On All Orders"), null);
  // A real badge alongside a prepaid span keeps only the badge.
  assert.equal(
    extractOfferText("Flat 40% Off + Extra 5% Prepaid Off"),
    "FLAT 40% OFF"
  );
});

test("regex state does not leak across repeated calls", () => {
  // Guards against a module-level global regex retaining lastIndex.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(extractCashbackFields("Get 15% Cashback"), {
      cashbackText: "15%",
      bankOfferText: null,
      prepaidText: null,
    });
    assert.equal(extractOfferText("Flat 20% Off"), "FLAT 20% OFF");
  }
});
