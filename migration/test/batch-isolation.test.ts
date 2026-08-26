import assert from "node:assert/strict";
import test from "node:test";
import {
  isRecordSpecificPostgresError,
  persistBatchWithIsolation,
} from "../src/utils/batch-isolation.js";

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code });
}

test("record-specific failures are isolated while valid records persist", async () => {
  const attempts: number[][] = [];
  const failures: number[] = [];
  const persisted = await persistBatchWithIsolation({
    batch: [1, 2, 3, 4],
    persist: async (batch) => {
      attempts.push([...batch]);
      if (batch.includes(3)) throw pgError("23514");
      return batch.map((value) => `saved-${value}`);
    },
    onRecordFailure: (record) => failures.push(record),
  });

  assert.deepEqual(persisted, ["saved-1", "saved-2", "saved-4"]);
  assert.deepEqual(failures, [3]);
  assert.ok(attempts.some((batch) => batch.length === 1 && batch[0] === 3));
});

test("schema failures abort without pointless record bisection", async () => {
  let attempts = 0;
  await assert.rejects(
    persistBatchWithIsolation({
      batch: [1, 2, 3],
      persist: async () => {
        attempts++;
        throw pgError("42P10");
      },
      onRecordFailure: () => assert.fail("schema errors are not row-specific"),
    }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "42P10",
  );
  assert.equal(attempts, 1);
});

test("PostgreSQL data/constraint classes are the only isolated errors", () => {
  assert.equal(isRecordSpecificPostgresError(pgError("22001")), true);
  assert.equal(isRecordSpecificPostgresError(pgError("23505")), true);
  assert.equal(isRecordSpecificPostgresError(pgError("P0001")), true);
  assert.equal(isRecordSpecificPostgresError(pgError("42P10")), false);
  assert.equal(isRecordSpecificPostgresError(new Error("timeout")), false);
});
