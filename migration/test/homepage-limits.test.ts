import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HOMEPAGE_SEED_LIMITS } from "../src/utils/homepage-limits.js";

// Direct-SQL migration writes bypass Strapi's repeatable-component `max`
// validation, so nothing at runtime stops a seed limit from drifting past
// the component schema. This test is the guard: every repeatable section's
// seed count must exactly fill (never exceed) its schema `max`.
const componentsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/components/home"
);

function schemaMax(file: string, field: string): number {
  const schema = JSON.parse(readFileSync(path.join(componentsDir, file), "utf8"));
  const max = schema.attributes?.[field]?.max;
  assert.equal(typeof max, "number", `${file} ${field}.max missing`);
  return max;
}

test("homepage seed limits match the component schema maximums", () => {
  assert.equal(HOMEPAGE_SEED_LIMITS.heroProducts, schemaMax("hero-section.json", "products"));
  assert.equal(HOMEPAGE_SEED_LIMITS.topOffers, schemaMax("top-offers.json", "items"));
  assert.equal(HOMEPAGE_SEED_LIMITS.cgExclusive, schemaMax("cg-exclusive.json", "items"));
  assert.equal(HOMEPAGE_SEED_LIMITS.newlyAdded, schemaMax("newly-added.json", "items"));
  assert.equal(HOMEPAGE_SEED_LIMITS.bankOffers, schemaMax("bank-offers.json", "items"));
});

test("relation-list seed limits match the API's per-section response caps", () => {
  // These sections are oneToMany relations (no schema max); the public API
  // caps them in src/api/homepage/controllers/custom.ts SECTION_LIST_CAPS.
  // Seeding more than the cap would silently discard rows at read time.
  assert.equal(HOMEPAGE_SEED_LIMITS.topDeals, 10);
  assert.equal(HOMEPAGE_SEED_LIMITS.exploreOffersPerTab, 10);
  assert.equal(HOMEPAGE_SEED_LIMITS.offersByBrand, 7);
  assert.equal(HOMEPAGE_SEED_LIMITS.popularStores, 31);
});
