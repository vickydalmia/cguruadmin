import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  homepageCouponOwnerEligibilitySql,
  selectHomepageHeroOffers,
} from "../src/utils/homepage-hero.js";

test("homepage hero seed keeps Product Deals when they exist", () => {
  assert.deepEqual(selectHomepageHeroOffers([1, 2], [10, 11]), [
    { entityType: "deal", id: 1 },
    { entityType: "deal", id: 2 },
  ]);
});

test("homepage hero seed falls back to Coupons only when Deals are absent", () => {
  assert.deepEqual(selectHomepageHeroOffers([], [10, 11]), [
    { entityType: "coupon", id: 10 },
    { entityType: "coupon", id: 11 },
  ]);
});

test("Coupon hero fallback requires a routable owner with a real logo", () => {
  const sql = homepageCouponOwnerEligibilitySql([
    {
      table: "coupons_stores_lnk",
      sourceCol: "coupon_id",
      targetCol: "store_id",
      entityTable: "stores",
      entityType: "api::store.store",
    },
  ]);

  assert.match(sql, /FROM "coupons_stores_lnk" owner_link/u);
  assert.match(sql, /JOIN "stores" owner/u);
  assert.match(sql, /owner_media\.field = 'logo'/u);
  assert.match(sql, /owner\.published_at IS NOT NULL/u);
  assert.match(sql, /NULLIF\(BTRIM\(owner\.name\), ''\) IS NOT NULL/u);
  assert.match(sql, /NULLIF\(BTRIM\(owner\.slug\), ''\) IS NOT NULL/u);
  assert.match(sql, /NULLIF\(BTRIM\(owner_file\.url\), ''\) IS NOT NULL/u);
  assert.match(sql, /c\.is_for_affiliate_brand IS TRUE AND \(\s*FALSE/u);
  assert.match(sql, /c\.is_for_affiliate_brand IS NOT TRUE/u);
  const brandSql = homepageCouponOwnerEligibilitySql([
    {
      table: "coupons_brands_lnk",
      sourceCol: "coupon_id",
      targetCol: "brand_id",
      entityTable: "brands",
      entityType: "api::brand.brand",
    },
  ]);
  assert.match(
    brandSql,
    /c\.is_for_affiliate_brand IS TRUE[\s\S]*JOIN "brands" owner/u,
  );
  assert.equal(homepageCouponOwnerEligibilitySql([]), "FALSE");
});

test("an existing homepage only fills an empty Hero Offer list", () => {
  const source = readFileSync(
    new URL("../src/phases/13-site-content.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /existing Hero Offers preserved/u);
  assert.match(source, /COUNT\(\*\)::text AS count[\s\S]*field = 'products'/u);
  assert.match(source, /insertHomepageHeroOffers\(heroId, data/u);
});
