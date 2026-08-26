import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { excludedStoresFile } from "../src/utils/import-exclusions.js";
import { migrationProfile, migrationStateDir } from "../src/utils/profile-state.js";

function withTempRoot(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cguru-profile-state-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("profile state defaults and USA state never share a directory", () => {
  withTempRoot((root) => {
    const options = { rootDir: root };
    const india = migrationStateDir(
      { MIGRATION_PROFILE: "india" } as NodeJS.ProcessEnv,
      options,
    );
    const usa = migrationStateDir(
      { MIGRATION_PROFILE: "usa" } as NodeJS.ProcessEnv,
      options,
    );
    assert.notEqual(india, usa);
    assert.match(india, /\.state\/india$/u);
    assert.match(usa, /\.state\/usa$/u);
  });
});

test("India adopts the complete legacy state directory in one move", () => {
  withTempRoot((root) => {
    const legacy = path.join(root, ".checkpoints");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "03-stores.json"), "{}");
    fs.writeFileSync(path.join(legacy, "storeIdMap.json"), "{}");

    const stateDir = migrationStateDir(
      { MIGRATION_PROFILE: "india" } as NodeJS.ProcessEnv,
      { rootDir: root },
    );

    assert.equal(stateDir, path.join(root, ".state", "india"));
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(path.join(stateDir, "03-stores.json")), true);
    assert.equal(fs.existsSync(path.join(stateDir, "storeIdMap.json")), true);
  });
});

test("conflicting legacy and India state fail closed without moving either", () => {
  withTempRoot((root) => {
    const legacy = path.join(root, ".checkpoints");
    const target = path.join(root, ".state", "india");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "legacy.json"), "{}");
    fs.writeFileSync(path.join(target, "current.json"), "{}");

    assert.throws(
      () =>
        migrationStateDir(
          { MIGRATION_PROFILE: "india" } as NodeJS.ProcessEnv,
          { rootDir: root },
        ),
      /both \.checkpoints\/ and \.state\/india hold state/u,
    );
    assert.equal(fs.existsSync(path.join(legacy, "legacy.json")), true);
    assert.equal(fs.existsSync(path.join(target, "current.json")), true);
  });
});

test("a non-empty log-only target safely falls back to intact legacy state", () => {
  withTempRoot((root) => {
    const legacy = path.join(root, ".checkpoints");
    const target = path.join(root, ".state", "india");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "phase.json"), "{}");
    fs.writeFileSync(path.join(target, "migration.log"), "booted");

    const stateDir = migrationStateDir(
      { MIGRATION_PROFILE: "india" } as NodeJS.ProcessEnv,
      { rootDir: root },
    );

    assert.equal(stateDir, legacy);
    assert.equal(fs.existsSync(path.join(legacy, "phase.json")), true);
    assert.equal(fs.existsSync(path.join(target, "migration.log")), true);
  });
});

test("unsafe profile names fail closed", () => {
  assert.equal(migrationProfile({ MIGRATION_PROFILE: "USA" } as NodeJS.ProcessEnv), "usa");
  assert.throws(() =>
    migrationProfile({ MIGRATION_PROFILE: "../india" } as NodeJS.ProcessEnv),
  );
});

test("USA exclusions resolve only inside the USA profile", () => {
  const usaExclusions = excludedStoresFile({
    MIGRATION_PROFILE: "usa",
  } as NodeJS.ProcessEnv);
  assert.match(usaExclusions, /profiles\/usa\/excluded-stores\.csv$/u);
  assert.doesNotMatch(usaExclusions, /migration\/excluded-stores\.csv$/u);
});
