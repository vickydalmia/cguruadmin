import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FOOTER_COUNTRY_ASSETS,
  GOOGLE_PREFERRED_DEFAULT,
} from "../src/utils/footer-media-assets.js";

test("footer migration carries every country in the required display order", () => {
  assert.deepEqual(
    FOOTER_COUNTRY_ASSETS.map(({ code, name, url }) => ({ code, name, url })),
    [
      { code: "us", name: "USA", url: "https://www.couponzguruusa.com/" },
      { code: "sg", name: "Singapore", url: "https://www.couponzguru.sg/" },
      { code: "ph", name: "Philippines", url: "https://www.couponzguru.ph/" },
      { code: "ae", name: "UAE", url: "https://www.couponzguru.ae/" },
      { code: "my", name: "Malaysia", url: "https://www.couponzguru.my/" },
    ],
  );
  for (const asset of FOOTER_COUNTRY_ASSETS) {
    assert.ok(readFileSync(asset.assetPath).length > 0);
  }
});

test("Google Preferred migration uses the exact Figma icon and approved URL", () => {
  const iconHash = createHash("sha256")
    .update(readFileSync(GOOGLE_PREFERRED_DEFAULT.assetPath))
    .digest("hex");

  assert.equal(
    iconHash,
    "cc30a73d1fd3653f954c3a10b6bddf22fc8958ef8aeb024d256f7e1263423724",
  );
  assert.equal(
    GOOGLE_PREFERRED_DEFAULT.url,
    "https://google.com/preferences/source?q=www.couponzguru.com",
  );
});
