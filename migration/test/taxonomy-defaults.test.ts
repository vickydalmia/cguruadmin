import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/phases/03-taxonomies.ts", import.meta.url),
  "utf8",
);

// Schema-json defaults never reach the database (schema sync creates plain
// nullable columns), so defaulted booleans the importer omits land NULL. For
// show_trending_deals a NULL renders as OFF in the admin toggle even though
// the runtime treats NULL as visible — an editor saving without touching it
// would persist false and silently hide the section.
test("taxonomy INSERT seeds defaulted booleans explicitly", () => {
  assert.match(source, /"show_trending_deals",/);
  // is_cj_enabled exists on stores only — must be gated, not unconditional.
  assert.match(
    source,
    /\.\.\.\(table === "stores" \? \["is_cj_enabled"\] : \[\]\)/,
  );
  assert.match(source, /true, \/\/ show_trending_deals/);
  assert.match(source, /\.\.\.\(table === "stores" \? \[false\] : \[\]\)/);
  assert.match(
    source,
    /\.\.\.\(table === "brands" \? \["is_affiliate_store"\] : \[\]\)/,
  );
  assert.match(source, /\.\.\.\(table === "brands" \? \[true\] : \[\]\)/);
});

test("defaulted booleans are fill-only on conflict (editor toggles win)", () => {
  assert.match(
    source,
    /"show_trending_deals" = COALESCE\("\$\{table\}"\."show_trending_deals", EXCLUDED\."show_trending_deals"\)/,
  );
  assert.match(
    source,
    /"is_cj_enabled" = COALESCE\("stores"\."is_cj_enabled", EXCLUDED\."is_cj_enabled"\)/,
  );
  // Never bare-EXCLUDED these — that would overwrite editor values on re-run.
  assert.doesNotMatch(source, /"show_trending_deals" = EXCLUDED/);
  assert.doesNotMatch(source, /"is_cj_enabled" = EXCLUDED/);
});

test("Brand affiliate seeding is fill-only so editor toggles win on re-import", () => {
  assert.match(
    source,
    /"is_affiliate_store" = COALESCE\("brands"\."is_affiliate_store", EXCLUDED\."is_affiliate_store"\)/,
  );
  assert.doesNotMatch(source, /"is_affiliate_store" = EXCLUDED/);
});

test("taxonomy import seeds entity page templates without overwriting editor choices", () => {
  assert.match(source, /"page_template",/);
  assert.match(source, /sourceSlug === "deal-of-the-day"/);
  assert.match(source, /\? "dealTemplate"/);
  assert.match(source, /"independenceDayTemplate"/);
  assert.match(
    source,
    /"page_template" = COALESCE\("\$\{table\}"\."page_template", EXCLUDED\."page_template"\)/,
  );
  assert.doesNotMatch(source, /"page_template" = EXCLUDED/);
});
