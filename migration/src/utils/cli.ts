// Config-free on purpose: the tsx test suite imports this module directly,
// and config.ts throws on import without .env.migration.

/** Parsed --limit flag: absent, a validated positive integer, or invalid. */
export type LimitFlag =
  | { kind: "absent" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; reason: string };

/**
 * Strict --limit parsing: accepts `--limit N` and `--limit=N` where N is a
 * positive safe integer (/^\d+$/). Anything present-but-invalid returns
 * `invalid` so the caller can abort BEFORE touching config/DB/S3 — a lenient
 * parse would silently run unbounded on typos like `--limit --overwrite`.
 * Pure (no process.exit) so tests can cover the full matrix.
 */
export function parseLimitFlag(argv: readonly string[]): LimitFlag {
  // Every occurrence is inspected: a malformed later occurrence must abort
  // rather than be shadowed by an earlier valid one.
  let parsed: LimitFlag = { kind: "absent" };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    let raw: string;
    if (token === "--limit") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          kind: "invalid",
          reason:
            next === undefined
              ? "--limit requires a value (e.g. --limit 50)"
              : `--limit requires a value, got flag "${next}" (e.g. --limit 50)`,
        };
      }
      raw = next;
    } else if (token.startsWith("--limit=")) {
      raw = token.slice("--limit=".length);
    } else {
      continue;
    }
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      return {
        kind: "invalid",
        reason: `--limit expects a positive integer, got "${raw}"`,
      };
    }
    if (parsed.kind === "absent") parsed = { kind: "valid", value };
  }
  return parsed;
}

/** Parsed --resume-from-term flag for interrupted taxonomy migrations. */
export type ResumeFromTermFlag =
  | { kind: "absent" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; reason: string };

/**
 * Accepts `--resume-from-term N` and `--resume-from-term=N`. The term itself
 * is intentionally included: it may have been inserted before a later media
 * or component operation failed, so starting after it would preserve a
 * partially reconciled entity.
 */
export function parseResumeFromTermFlag(
  argv: readonly string[],
): ResumeFromTermFlag {
  let parsed: ResumeFromTermFlag = { kind: "absent" };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    let raw: string;
    if (token === "--resume-from-term") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          kind: "invalid",
          reason:
            next === undefined
              ? "--resume-from-term requires a term ID"
              : `--resume-from-term requires a term ID, got flag "${next}"`,
        };
      }
      raw = next;
    } else if (token.startsWith("--resume-from-term=")) {
      raw = token.slice("--resume-from-term=".length);
    } else {
      continue;
    }

    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      return {
        kind: "invalid",
        reason: `--resume-from-term expects a positive integer, got "${raw}"`,
      };
    }
    if (parsed.kind === "valid") {
      return {
        kind: "invalid",
        reason: "--resume-from-term may be specified only once",
      };
    }
    parsed = { kind: "valid", value };
  }
  return parsed;
}
