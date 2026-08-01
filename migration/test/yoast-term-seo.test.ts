import assert from "node:assert/strict";
import test from "node:test";
import { serialize } from "php-serialize";
import {
  parseYoastSiteConfig,
  resolveTermSeo,
  resolveYoastTemplate,
} from "../src/utils/yoast-term-seo.js";

const SITE = { separator: "|", siteName: "CouponzGuru" };

test("template variables resolve with the real separator and site name", () => {
  assert.equal(
    resolveYoastTemplate(
      "%%term_title%% Coupons %%sep%% %%sitename%%",
      { termName: "Amazon" },
      SITE,
    ),
    "Amazon Coupons | CouponzGuru",
  );
  assert.equal(
    resolveYoastTemplate(
      "%%term_title%% Offers %%currentyear%%",
      { termName: "Nykaa" },
      SITE,
    ),
    `Nykaa Offers ${new Date().getFullYear()}`,
  );
  // Unknown vars vanish; a dangling separator left behind is trimmed.
  assert.equal(
    resolveYoastTemplate(
      "%%term_title%% %%sep%% %%page%%",
      { termName: "Ajio" },
      SITE,
    ),
    "Ajio",
  );
  assert.equal(
    resolveYoastTemplate(
      "Save at %%term_title%%: %%term_description%%",
      { termName: "Myntra", termDescription: "Fashion deals daily." },
      SITE,
    ),
    "Save at Myntra: Fashion deals daily.",
  );
});

function siteConfig(): ReturnType<typeof parseYoastSiteConfig> {
  return parseYoastSiteConfig({
    wpseoTitles: serialize({
      separator: "sc-pipe",
      "title-tax-category": "%%term_title%% Coupons %%sep%% %%sitename%%",
      "metadesc-tax-category": "Best %%term_title%% offers.",
      "noindex-tax-category": false,
    }),
    wpseoTaxonomyMeta: serialize({
      category: {
        "42": {
          wpseo_title: "Amazon Promo Codes %%sep%% %%sitename%%",
          wpseo_desc: "Hand-tested Amazon codes.",
          wpseo_canonical: "https://www.couponzguru.com/amazon-coupons/",
          wpseo_noindex: "index",
        },
        "43": { wpseo_noindex: "noindex" },
      },
    }),
    blogname: "CouponzGuru",
  });
}

test("per-term override beats the taxonomy template; canonical carried", () => {
  const seo = resolveTermSeo(siteConfig(), {
    termId: 42,
    taxonomy: "category",
    termName: "Amazon",
  });
  assert.equal(seo.metaTitle, "Amazon Promo Codes | CouponzGuru");
  assert.equal(seo.metaDescription, "Hand-tested Amazon codes.");
  assert.equal(seo.canonicalUrl, "https://www.couponzguru.com/amazon-coupons/");
  assert.equal(seo.noIndex, false);
});

test("terms without overrides get the resolved taxonomy template", () => {
  const seo = resolveTermSeo(siteConfig(), {
    termId: 99,
    taxonomy: "category",
    termName: "Flipkart",
  });
  assert.equal(seo.metaTitle, "Flipkart Coupons | CouponzGuru");
  assert.equal(seo.metaDescription, "Best Flipkart offers.");
  assert.equal(seo.canonicalUrl, null);
  assert.equal(seo.noIndex, false);
});

test("noindex resolution: per-term wins, else taxonomy default", () => {
  const perTerm = resolveTermSeo(siteConfig(), {
    termId: 43,
    taxonomy: "category",
    termName: "Old Store",
  });
  assert.equal(perTerm.noIndex, true);

  const taxDefault = parseYoastSiteConfig({
    wpseoTitles: serialize({
      separator: "sc-dash",
      "noindex-tax-category": "1",
    }),
    wpseoTaxonomyMeta: null,
    blogname: null,
  });
  assert.equal(
    resolveTermSeo(taxDefault, {
      termId: 1,
      taxonomy: "category",
      termName: "X",
    }).noIndex,
    true,
  );
});

test("malformed/missing options degrade to safe defaults", () => {
  const broken = parseYoastSiteConfig({
    wpseoTitles: "not-serialized-php",
    wpseoTaxonomyMeta: null,
    blogname: null,
  });
  assert.equal(broken.separator, "-");
  assert.equal(broken.siteName, "CouponzGuru");
  const seo = resolveTermSeo(broken, {
    termId: 1,
    taxonomy: "category",
    termName: "Amazon",
  });
  assert.equal(seo.metaTitle, null); // caller applies the name fallback
  assert.equal(seo.noIndex, false);
});
