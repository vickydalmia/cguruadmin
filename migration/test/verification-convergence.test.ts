import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const verificationSource = readFileSync(
  new URL("../src/phases/10-verify.ts", import.meta.url),
  "utf8",
);
const couponSource = readFileSync(
  new URL("../src/phases/07-coupons.ts", import.meta.url),
  "utf8",
);
const dealSource = readFileSync(
  new URL("../src/phases/08-deals.ts", import.meta.url),
  "utf8",
);
const userSource = readFileSync(
  new URL("../src/phases/06a-users.ts", import.meta.url),
  "utf8",
);
const offerBackfillSource = readFileSync(
  new URL("../src/phases/12-offer-backfill.ts", import.meta.url),
  "utf8",
);

test("offer source queries read only statuses the lifecycle predicate can import", () => {
  // publish + future ONLY: drafts and trash never import (the old
  // withdrawn-by-expiry retention was deliberately dropped), so fetching
  // them would be wasted work the lifecycle predicate rejects anyway.
  const statusFilter = /post_status IN \('publish', 'future'\)/;

  assert.match(couponSource, statusFilter);
  assert.match(dealSource, statusFilter);
  assert.match(verificationSource, statusFilter);
  for (const source of [couponSource, dealSource, verificationSource]) {
    assert.doesNotMatch(source, /'draft', 'trash'/);
  }
});

test("offer backfill applies the same expiry lifecycle as import and verify", () => {
  assert.match(offerBackfillSource, /shouldImportMigrationOffer/);
  assert.match(offerBackfillSource, /getWpOfferExpiryRaw/);
  assert.match(offerBackfillSource, /const lifecycleRows = rows\.filter/);
});

test("code verification uses the same resolved-pool ownership as Phase 6", () => {
  assert.match(verificationSource, /getAllPoolMappings/);
  assert.match(verificationSource, /mappedWpPoolIds/);
  assert.match(verificationSource, /CONCAT\('unlinked:', code\.id\)/);
  assert.doesNotMatch(verificationSource, /WHEN pool\.id IS NULL/);
});

test("user verification collapses source emails and accepts resolved existing users", () => {
  assert.match(userSource, /clean\(user\.user_email\)\?\.toLowerCase\(\)/);
  assert.match(userSource, /usersByEmail/);
  assert.match(
    userSource,
    /for \(const groupedUser of groupedUsers\)[\s\S]*setUserMapping/,
  );
  assert.match(
    verificationSource,
    /GROUP BY LOWER\(TRIM\(user_email\)\)/,
  );
  assert.match(
    verificationSource,
    /LOWER\(email\) = ANY\(\$1::text\[\]\)/,
  );
  assert.doesNotMatch(
    verificationSource,
    /JOIN migration_source_entities registry[\s\S]*entity: "Users"/,
  );
});
