import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMigrationStatus,
  shouldImportMigrationOffer,
} from "../src/utils/content-status.js";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const PAST = "2026-07-25T11:59:59.000Z";
const FUTURE = "2026-07-25T12:00:01.000Z";

test("imports published and scheduled WordPress offers", () => {
  assert.equal(
    shouldImportMigrationOffer({ postStatus: "publish", now: NOW }),
    true,
  );
  assert.equal(
    shouldImportMigrationOffer({ postStatus: "future", now: NOW }),
    true,
  );
});

// Drafts and trash NEVER import — including the old special case that
// retained a draft/trash row when an expiry plugin withdrew it. The fresh
// catalog carries publish/future posts only; expired-by-meta PUBLISHED posts
// still import (as contentStatus "expired").
test("excludes draft and trash offers regardless of expiry", () => {
  for (const postStatus of ["draft", "trash"]) {
    assert.equal(
      shouldImportMigrationOffer({ postStatus, expiresAt: null, now: NOW }),
      false,
    );
    assert.equal(
      shouldImportMigrationOffer({ postStatus, expiresAt: FUTURE, now: NOW }),
      false,
    );
    assert.equal(
      shouldImportMigrationOffer({ postStatus, expiresAt: PAST, now: NOW }),
      false,
    );
  }
  assert.equal(
    shouldImportMigrationOffer({
      postStatus: "private",
      expiresAt: PAST,
      now: NOW,
    }),
    false,
  );
});

test("published offers with an elapsed expiry import as expired entries", () => {
  assert.equal(
    shouldImportMigrationOffer({
      postStatus: "publish",
      expiresAt: PAST,
      now: NOW,
    }),
    true,
  );
  assert.equal(
    computeMigrationStatus({
      postStatus: "publish",
      postDate: "2026-07-01T00:00:00.000Z",
      expiresAt: PAST,
      now: NOW,
    }).contentStatus,
    "expired",
  );
});

test("expiry wins over a future WordPress status", () => {
  assert.deepEqual(
    computeMigrationStatus({
      postStatus: "future",
      postDate: FUTURE,
      expiresAt: PAST,
      now: NOW,
    }),
    {
      contentStatus: "expired",
      scheduledAt: null,
      publishedAt: FUTURE,
    },
  );
});
