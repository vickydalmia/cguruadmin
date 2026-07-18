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
