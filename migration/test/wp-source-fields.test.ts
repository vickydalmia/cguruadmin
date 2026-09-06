import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OFFER_META_ALIASES,
  TERM_META_ALIASES,
  firstAliasValue,
  normaliseOfferMeta,
  offerMetaKeys,
  sqlMetaKeyList,
  termMetaCoalesceSql,
  termMetaKeys,
} from "../src/utils/wp-source-fields.js";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("canonical key wins over a Singapore alias when both are present", () => {
  assert.deepEqual(
    normaliseOfferMeta({
      code: "ACF10",
      _cmb_coupon_code: "CMB10",
      link: "https://a.example/",
      _cmb_affiliate_link: "https://b.example/",
      image: "https://a.example/a.jpg",
      _cmb_coupon_image: "https://b.example/b.jpg",
      popular_coupon: "1",
    }),
    {
      code: "ACF10",
      link: "https://a.example/",
      image: "https://a.example/a.jpg",
      popular_coupon: "1",
    },
  );
});

test("Singapore aliases fill in when the canonical key is missing or blank", () => {
  assert.deepEqual(
    normaliseOfferMeta({
      _cmb_coupon_code: "SG15",
      link: "   ",
      _cmb_affiliate_link: "http://clk.example/?id=1",
      _cmb_coupon_image: "http://www.couponzguru.sg/wp-content/uploads/x.jpg",
      _edit_last: "3",
    }),
    {
      code: "SG15",
      link: "http://clk.example/?id=1",
      image: "http://www.couponzguru.sg/wp-content/uploads/x.jpg",
      _edit_last: "3",
    },
  );
});

test("a source with only canonical keys is returned unchanged", () => {
  const india = {
    code: "FLAT50",
    link: "https://www.example.com/",
    image: "https://www.couponzguru.com/wp-content/uploads/logo.jpg",
    is_deal: "no",
    "_expiration-date": "1700000000",
  };
  assert.deepEqual(normaliseOfferMeta({ ...india }), india);
});

test("a blank canonical value with no alias is preserved as the source had it", () => {
  assert.deepEqual(normaliseOfferMeta({ code: "", link: "x" }), { code: "", link: "x" });
});

test("offer and term key lists contain every alias exactly once", () => {
  const offer = offerMetaKeys(["popular_coupon", "code"]);
  assert.deepEqual(
    [...offer].sort(),
    [
      "code",
      "_cmb_coupon_code",
      "link",
      "_cmb_affiliate_link",
      "image",
      "_cmb_coupon_image",
      "popular_coupon",
    ].sort(),
  );
  assert.equal(new Set(offer).size, offer.length);

  const term = termMetaKeys(["choose_type"]);
  assert.deepEqual(
    [...term].sort(),
    ["store_cat_image", "store_image", "store_image_alt", "choose_type"].sort(),
  );
});

test("meta keys never start with wp_ (the table-prefix rewriter would mangle them)", () => {
  for (const key of [...offerMetaKeys(), ...termMetaKeys()]) {
    assert.doesNotMatch(key, /^wp_/iu);
  }
  assert.throws(() => sqlMetaKeyList(["wp_sneaky"]), /Unsupported WordPress meta key/u);
  assert.throws(() => sqlMetaKeyList(["bad'key"]), /Unsupported WordPress meta key/u);
});

test("sqlMetaKeyList renders a quoted, deduplicated IN list", () => {
  assert.equal(
    sqlMetaKeyList(["code", "_cmb_coupon_code", "code"]),
    "'code', '_cmb_coupon_code'",
  );
});

test("termMetaCoalesceSql resolves aliases in order and blanks fall through", () => {
  assert.equal(
    termMetaCoalesceSql(TERM_META_ALIASES.image),
    "COALESCE(" +
      "MAX(CASE WHEN tm.meta_key = 'store_cat_image' THEN NULLIF(tm.meta_value, '') END), " +
      "MAX(CASE WHEN tm.meta_key = 'store_image' THEN NULLIF(tm.meta_value, '') END))",
  );
  assert.equal(
    termMetaCoalesceSql(TERM_META_ALIASES.imageAlt),
    "MAX(CASE WHEN tm.meta_key = 'store_image_alt' THEN NULLIF(tm.meta_value, '') END)",
  );
});

test("firstAliasValue honours alias order rather than row order", () => {
  const rows = [
    { meta_key: "_cmb_coupon_image", meta_value: "http://sg.example/b.jpg" },
    { meta_key: "image", meta_value: "http://in.example/a.jpg" },
  ];
  assert.equal(
    firstAliasValue(OFFER_META_ALIASES.image, rows),
    "http://in.example/a.jpg",
  );
  assert.equal(
    firstAliasValue(OFFER_META_ALIASES.image, [
      { meta_key: "image", meta_value: "" },
      rows[0],
    ]),
    "http://sg.example/b.jpg",
  );
  assert.equal(firstAliasValue(OFFER_META_ALIASES.image, []), undefined);
});

test("every WordPress offer/term reader goes through the alias helper", () => {
  const coupons = source("../src/phases/07-coupons.ts");
  const deals = source("../src/phases/08-deals.ts");
  const verify = source("../src/phases/10-verify.ts");
  const siteContent = source("../src/phases/13-site-content.ts");
  const taxonomies = source("../src/phases/03-taxonomies.ts");
  const logoStore = source("../src/utils/offer-logo-store.ts");

  for (const [name, text] of [
    ["07-coupons", coupons],
    ["08-deals", deals],
  ] as const) {
    assert.match(text, /offerMetaKeys\(\[/, `${name} builds its IN list from offerMetaKeys`);
    assert.match(text, /normaliseOfferMeta\(meta\)/, `${name} normalises aliases`);
    assert.doesNotMatch(text, /'code',\s*'link'/, `${name} has no hardcoded code/link list`);
  }
  assert.match(verify, /OFFER_META_ALIASES\.link/);
  assert.match(verify, /normaliseOfferMeta\(meta\)/);
  assert.match(siteContent, /sqlMetaKeyList\(OFFER_META_ALIASES\.image\)/);
  assert.match(siteContent, /firstAliasValue\(OFFER_META_ALIASES\.image/);
  assert.match(taxonomies, /termMetaCoalesceSql\(TERM_META_ALIASES\.image\)\} AS image_ref/);
  assert.match(taxonomies, /termMetaCoalesceSql\(TERM_META_ALIASES\.imageAlt\)\} AS image_alt/);
  assert.doesNotMatch(taxonomies, /meta_key='store_cat_image'/);
  assert.match(logoStore, /logo\.meta_key IN \(\$\{sqlMetaKeyList\(TERM_META_ALIASES\.image\)\}\)/);
});
