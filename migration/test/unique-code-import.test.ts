import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseBatchDuplicateCodes,
  type PreparedUniqueCode,
} from "../src/utils/unique-code-import.js";

const candidate = (
  overrides: Partial<PreparedUniqueCode>,
): PreparedUniqueCode => ({
  wpId: 1,
  targetPoolId: 10,
  documentId: "doc-1",
  code: "SAVE20",
  isUsed: false,
  version: 0,
  ...overrides,
});

test("collapses equal codes only inside the same pool", () => {
  const result = collapseBatchDuplicateCodes([
    candidate({ wpId: 1, documentId: "doc-1" }),
    candidate({ wpId: 2, documentId: "doc-2" }),
    candidate({ wpId: 3, documentId: "doc-3", targetPoolId: 11 }),
    candidate({ wpId: 4, documentId: "doc-4", code: "save20" }),
  ]);

  assert.equal(result.removed, 1);
  assert.equal(result.rows.length, 3);
});

test("the lowest source identity remains stable while used state is merged", () => {
  const result = collapseBatchDuplicateCodes([
    candidate({ wpId: 1, documentId: "unused", version: 8 }),
    candidate({
      wpId: 2,
      documentId: "used",
      isUsed: true,
      version: 3,
    }),
  ]);

  assert.deepEqual(result.rows, [
    candidate({
      wpId: 1,
      documentId: "unused",
      isUsed: true,
      version: 8,
    }),
  ]);
});

test("unlinked rows retain independent WordPress identities", () => {
  const result = collapseBatchDuplicateCodes([
    candidate({ wpId: 1, documentId: "doc-1", targetPoolId: null }),
    candidate({ wpId: 2, documentId: "doc-2", targetPoolId: null }),
  ]);

  assert.equal(result.removed, 0);
  assert.equal(result.rows.length, 2);
});
