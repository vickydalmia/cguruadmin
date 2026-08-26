import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FOOTER_COUNTRY_ASSETS,
  footerCountryAssetsFor,
  googlePreferredAssetFor,
} from "../src/utils/footer-media-assets.js";

const INDIA_ENV = {
  MIGRATION_PROFILE: "india",
  SOURCE_COUNTRY_CODE: "IN",
};
const USA_ENV = {
  MIGRATION_PROFILE: "usa",
  SOURCE_COUNTRY_CODE: "US",
};

test("India footer carries every other country in the required display order", () => {
  const assets = footerCountryAssetsFor(INDIA_ENV);
  assert.deepEqual(
    assets.map(({ code, name, url }) => ({ code, name, url })),
    [
      { code: "us", name: "USA", url: "https://www.couponzguruusa.com/" },
      { code: "sg", name: "Singapore", url: "https://www.couponzguru.sg/" },
      { code: "ph", name: "Philippines", url: "https://www.couponzguru.ph/" },
      { code: "ae", name: "UAE", url: "https://www.couponzguru.ae/" },
      { code: "my", name: "Malaysia", url: "https://www.couponzguru.my/" },
    ]
  );
  for (const asset of assets) {
    assert.ok(readFileSync(asset.assetPath).length > 0);
  }
});

test("USA footer includes India and excludes USA", () => {
  const assets = footerCountryAssetsFor(USA_ENV);
  assert.deepEqual(
    assets.map(({ code }) => code),
    ["in", "sg", "ph", "ae", "my"]
  );
  assert.equal(
    assets.find(({ code }) => code === "in")?.url,
    "https://www.couponzguru.com/"
  );
  assert.equal(
    assets.some(({ code }) => code === "us"),
    false
  );
  for (const asset of assets) {
    assert.ok(readFileSync(asset.assetPath).length > 0);
  }
});

test("runtime footer constant also excludes its configured current country", () => {
  const current = (process.env.SOURCE_COUNTRY_CODE ?? "IN").toLowerCase();
  assert.equal(
    FOOTER_COUNTRY_ASSETS.some(({ code }) => code === current),
    false
  );
});

test("Google Preferred migration uses the exact Figma icon and approved URL", () => {
  const googlePreferred = googlePreferredAssetFor(INDIA_ENV);
  assert.ok(googlePreferred);
  const iconHash = createHash("sha256")
    .update(readFileSync(googlePreferred.assetPath))
    .digest("hex");

  assert.equal(
    iconHash,
    "cc30a73d1fd3653f954c3a10b6bddf22fc8958ef8aeb024d256f7e1263423724"
  );
  assert.equal(
    googlePreferred.url,
    "https://google.com/preferences/source?q=www.couponzguru.com"
  );
});
