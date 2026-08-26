import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dealsSource = readFileSync(
  new URL("../src/phases/08-deals.ts", import.meta.url),
  "utf8",
);
const couponsSource = readFileSync(
  new URL("../src/phases/07-coupons.ts", import.meta.url),
  "utf8",
);
const couponBatchSource = readFileSync(
  new URL("../src/utils/coupon-batch.ts", import.meta.url),
  "utf8",
);

// deals.coupon_type is required + load-bearing (a NULL type renders the Deal
// as a no-code offer) but schema sync never applies schema.json defaults at
// the DB level, so the raw-SQL importer must write it itself. Regression
// pinned here after a fresh import shipped every Deal with coupon_type NULL.
test("deal INSERT writes coupon_type with the static default", () => {
  assert.match(dealsSource, /"coupon_type",/);
  assert.match(dealsSource, /"static",/);
  // 24 placeholders — a renumbering slip in this INSERT shifts every value.
  assert.match(dealsSource, /\$24/);
});

test("deal coupon_type is fill-only on conflict; coupon stays authoritative", () => {
  // Deals: the import's 'static' is a default, not source data — an editor's
  // 'unique' (with its pool link) must survive re-imports.
  assert.match(
    dealsSource,
    /"coupon_type" = COALESCE\("deals"\."coupon_type", EXCLUDED\."coupon_type"\)/,
  );
  // Coupons: WordPress IS the source of truth for uniqueness and phase 07
  // reconciles the pool link in the same phase — authoritative overwrite is
  // correct there. This asymmetry is deliberate; do not "unify" it.
  assert.match(couponBatchSource, /"coupon_type" = EXCLUDED\."coupon_type"/);
  assert.doesNotMatch(
    couponBatchSource,
    /COALESCE\("coupons"\."coupon_type"/,
  );
  assert.match(couponsSource, /buildCouponUpsertBatchQuery/);
});
