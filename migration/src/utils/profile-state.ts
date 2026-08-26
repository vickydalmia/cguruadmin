import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SAFE_PROFILE = /^[a-z][a-z0-9-]*$/u;
// Pre-profile state lived in .checkpoints/; the india profile adopts it once
// so an in-flight run resumes and the media manifest survives the move.
const LEGACY_STATE_DIR = ".checkpoints";

let stateDirWarningDone = false;

// A state dir counts as holding real state only when it has JSON payloads
// (checkpoints, id maps, manifest) — log files alone (created by any boot of
// the new layout) must not block adopting the legacy state.
function hasStatePayload(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .some((name) => name.endsWith(".json"));
}

function adoptLegacyIndiaState(stateDir: string, rootDir: string): string {
  const legacyDir = path.resolve(rootDir, LEGACY_STATE_DIR);
  if (legacyDir === stateDir || !hasStatePayload(legacyDir)) return stateDir;
  if (hasStatePayload(stateDir)) {
    throw new Error(
      `[profile-state] both ${LEGACY_STATE_DIR}/ and ${path.relative(rootDir, stateDir)} hold state. Refusing to choose one: reconcile the checkpoints/id maps and remove the stale directory before continuing.`,
    );
  }

  // Never merge state entry-by-entry: interruption halfway through would
  // split checkpoints and ID maps across two roots. A non-empty target that
  // contains logs only falls back to the intact legacy directory; an absent
  // (or empty) target is replaced with one same-filesystem directory rename.
  if (fs.existsSync(stateDir)) {
    if (fs.readdirSync(stateDir).length > 0) {
      console.warn(
        `[profile-state] ${path.relative(rootDir, stateDir)} already contains non-state files; using intact legacy ${LEGACY_STATE_DIR}/ until the target is cleared.`,
      );
      return legacyDir;
    }
    fs.rmdirSync(stateDir);
  }
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });
  fs.renameSync(legacyDir, stateDir);
  console.warn(
    `[profile-state] adopted legacy ${LEGACY_STATE_DIR}/ into ${path.relative(rootDir, stateDir)} — checkpoints, id maps and the file manifest carry over.`,
  );
  return stateDir;
}

export type MigrationStateOptions = {
  /** Test/embedding seam; production always uses the migration workspace. */
  rootDir?: string;
  /** Lets callers inspect path defaults without mutating legacy state. */
  adoptLegacy?: boolean;
};

export function migrationProfile(environment: NodeJS.ProcessEnv = process.env): string {
  const profile = (environment.MIGRATION_PROFILE ?? "india").trim().toLowerCase();
  if (!SAFE_PROFILE.test(profile)) {
    throw new Error(
      "MIGRATION_PROFILE must start with a letter and contain only lowercase letters, numbers, or hyphens",
    );
  }
  return profile;
}

export function migrationStateDir(
  environment: NodeJS.ProcessEnv = process.env,
  options: MigrationStateOptions = {},
): string {
  const rootDir = options.rootDir ?? MIGRATION_ROOT;
  const profile = migrationProfile(environment);
  const configured = environment.MIGRATION_STATE_DIR?.trim();

  // A pinned MIGRATION_STATE_DIR overrides the per-profile default, so a
  // profile switch that forgets to move it would silently resume another
  // country's checkpoints and id maps. Warn loudly once.
  if (configured && !configured.includes(profile) && !stateDirWarningDone) {
    stateDirWarningDone = true;
    console.warn(
      `[profile-state] MIGRATION_STATE_DIR ("${configured}") does not mention the active profile ("${profile}") — a stale pin here reuses another profile's checkpoints/id maps. Unset it to use .state/${profile}.`,
    );
  }

  const stateDir = path.resolve(
    rootDir,
    configured || `.state/${profile}`,
  );
  if (profile === "india" && options.adoptLegacy !== false) {
    return adoptLegacyIndiaState(stateDir, rootDir);
  }
  return stateDir;
}

export function migrationRoot(): string {
  return MIGRATION_ROOT;
}

export function profileFile(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(MIGRATION_ROOT, "profiles", migrationProfile(environment), name);
}
