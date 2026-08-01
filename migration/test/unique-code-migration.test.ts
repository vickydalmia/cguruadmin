import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/phases/06-codes.ts", import.meta.url),
  "utf8",
);
const integritySource = readFileSync(
  new URL("../../database/unique-code-integrity.js", import.meta.url),
  "utf8",
);

test("unique-code migration uses keyset pagination instead of OFFSET", () => {
  assert.match(source, /POSTGRES_LOOKUP_INDEXES/);
  assert.match(source, /postgresLookupIndexSql/);
  assert.doesNotMatch(source, /unique_codes_code_btree_idx/);
  assert.doesNotMatch(source, /unique_codes_pool_code_lookup_idx/);
  assert.match(integritySource, /unique_codes_code_btree_idx/);
  assert.match(integritySource, /unique_codes_pool_code_lookup_idx/);
  assert.match(source, /WHERE id > \?/);
  assert.match(source, /LIMIT \$\{batchSize\}/);
  assert.match(source, /\[lastSeenId\]/);
  assert.match(source, /MAX_CODE_BATCH_SIZE = 10_000/);
  assert.match(
    source,
    /Math\.min\(requestedBatchSize, MAX_CODE_BATCH_SIZE\)/,
  );
  assert.match(
    source,
    /Math\.floor\(POSTGRES_PARAMETER_LIMIT \/ 3\) - 1/,
  );
  assert.doesNotMatch(source, /\bOFFSET\b/);
});

test("unchanged re-import links bypass the per-row duplicate trigger", () => {
  assert.match(
    source,
    /INSERT INTO "unique_codes_pool_lnk"[\s\S]*WHERE NOT EXISTS/,
  );
  assert.match(
    source,
    /DELETE FROM "unique_codes_pool_lnk" AS existing[\s\S]*USING \(VALUES/,
  );
});

test("re-import preserves redeemed state and rolls back a failed batch", () => {
  assert.match(
    source,
    /"is_used" = "unique_codes"\."is_used" OR EXCLUDED\."is_used"/,
  );
  assert.match(source, /WHEN "unique_codes"\."is_used"/);
  assert.match(source, /await pgTransaction/);
  assert.match(source, /logger\.error\(`Batch \$\{batchNum\} failed/);
  assert.match(source, /throw err/);
});

test("duplicate convergence merges the live source redemption before deletion", () => {
  const lockIndex = source.indexOf(
    `WHERE "id" = ANY($1::bigint[])
                 OR "document_id" = ANY($2::text[])
              FOR UPDATE`,
  );
  const mergeIndex = source.indexOf(
    `COALESCE(duplicate."is_used", false) AS is_used`,
  );
  const deleteIndex = source.indexOf(
    `DELETE FROM "unique_codes" AS duplicate`,
  );

  assert.ok(lockIndex >= 0, "keeper and source rows must be locked");
  assert.ok(mergeIndex > lockIndex, "live source state must be read after locking");
  assert.ok(
    deleteIndex > mergeIndex,
    "the source row must only be deleted after its state is merged",
  );
  assert.match(source, /THEN duplicate\."used_at"/);
  assert.match(source, /COALESCE\(duplicate\."version", 0\)/);
  assert.match(
    source,
    /existing\."is_used" OR merge_source\.is_used/,
  );
});

test("pool moves unlink stale ownership before guarded code updates", () => {
  const unlinkIndex = source.indexOf(
    `DELETE FROM "unique_codes_pool_lnk" AS existing_link`,
  );
  const upsertIndex = source.indexOf(`INSERT INTO "unique_codes" (`);

  assert.ok(unlinkIndex >= 0, "stale pool links must be removed");
  assert.ok(upsertIndex > unlinkIndex, "unlink must happen before code upsert");
  assert.match(
    source,
    /desired\.unique_coupon_pool_id IS NULL[\s\S]*existing_link\."unique_coupon_pool_id" <>[\s\S]*desired\.unique_coupon_pool_id/,
  );
});

test("successful import recounts pool inventory after duplicate collapse", () => {
  assert.match(source, /UPDATE "unique_coupon_pools"/);
  assert.match(source, /COUNT\(\*\) FILTER \(WHERE code\."is_used"\)/);
  assert.match(source, /GROUP BY link\."unique_coupon_pool_id"/);
});

// Pools imported already-drained must carry exhausted_at immediately, not
// after the nightly cron: the offer-expiry cron reads it to expire the pool's
// offers. The stamping mirrors recountPools in unique-code-integrity.js —
// keep an existing stamp, clear it when stock came back, and never touch
// pools with zero code rows (editor-mid-setup pools are not in `inventory`).
test("recount stamps exhausted_at for drained pools like recountPools does", () => {
  assert.match(source, /"exhausted_at" = CASE/);
  assert.match(
    source,
    /inventory\.used_codes >= inventory\.total_codes/,
  );
  assert.match(source, /COALESCE\(pool\."exhausted_at", NOW\(\)\)/);
  assert.match(source, /ELSE NULL/);
  // The reference implementation carries the same drained rule.
  assert.match(integritySource, /const drained = total > 0 && used >= total/);
  assert.match(
    integritySource,
    /exhausted_at: drained \? \(pool\.exhausted_at \?\? now\) : null/,
  );
});
