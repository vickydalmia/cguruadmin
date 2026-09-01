import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  couponLogoStoreCandidates,
  normalizeWpMediaPath,
} from "../src/utils/offer-logo-store.js";
import {
  buildOfferTaxonomyRelationQuery,
  normaliseMigratedAffiliateBrandRelations,
} from "../src/utils/offer-relations.js";

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
  assert.match(
    couponsSource,
    /resolveOfferTaxonomyRelations\([\s\S]{0,500}logoStoreOnlyWithoutStore: true/,
  );
  assert.match(
    dealsSource,
    /resolveOfferTaxonomyRelations\([\s\S]{0,500}logoStoreOnlyWithoutStore: true/,
  );
});

test("Logo Store inserts match Strapi many-to-one link-table columns", () => {
  const query = buildOfferTaxonomyRelationQuery("coupons", 7, {
    idsByTable: { stores: [], brands: [], categories: [], banks: [] },
    logoStoreId: 42,
  });
  assert.match(
    query.sql,
    /INSERT INTO "coupons_logo_store_lnk" \(\s*"coupon_id", "store_id"/,
  );
  const logoInsert = query.sql.slice(query.sql.indexOf("upserted_logo_store"));
  assert.doesNotMatch(logoInsert, /coupon_ord|store_ord/);
  assert.deepEqual(query.params.at(-1), [42]);
});

test("Brand Coupons are flagged as affiliate offers with Brand-only ownership", () => {
  const normalized = normaliseMigratedAffiliateBrandRelations({
    idsByTable: {
      stores: [9],
      brands: [12, 13],
      categories: [4],
      banks: [3],
    },
    logoStoreId: 9,
  });
  assert.equal(normalized.isForAffiliateBrand, true);
  assert.deepEqual(normalized.resolved, {
    idsByTable: {
      stores: [],
      brands: [12, 13],
      categories: [4],
      banks: [3],
    },
    logoStoreId: null,
  });
  assert.match(couponsSource, /normaliseMigratedAffiliateBrandRelations/);
  assert.match(couponsSource, /isForAffiliateBrand,/);
});

test("Deals apply the same affiliate-brand rule at import and reconciliation", () => {
  const backfillSource = readFileSync(
    new URL("../src/phases/12-offer-backfill.ts", import.meta.url),
    "utf8",
  );
  for (const source of [dealsSource, backfillSource]) {
    assert.match(source, /normaliseMigratedAffiliateBrandRelations/);
    assert.match(source, /replaceResolvedOfferTaxonomyRelations/);
    assert.match(source, /logoStoreOnlyWithoutStore: true/);
  }
  // The flag reaches the row, not just the link tables.
  assert.match(dealsSource, /"is_for_affiliate_brand",/);
  assert.match(
    dealsSource,
    /"is_for_affiliate_brand" = EXCLUDED\."is_for_affiliate_brand"/,
  );
  assert.match(
    backfillSource,
    /UPDATE "deals" SET "is_for_affiliate_brand" = \$1/,
  );
});

test("non-Brand Coupons remain ordinary Store offers", () => {
  const resolved = {
    idsByTable: {
      stores: [9],
      brands: [],
      categories: [],
      banks: [],
    },
    logoStoreId: 9,
  };
  const normalized = normaliseMigratedAffiliateBrandRelations(resolved);
  assert.equal(normalized.isForAffiliateBrand, false);
  assert.equal(normalized.resolved, resolved);
});
