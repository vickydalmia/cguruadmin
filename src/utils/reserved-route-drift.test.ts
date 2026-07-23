import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * RESERVED_ROUTE_SEGMENTS exists twice: identity-validation.ts owns the
 * original and redirect-validation.ts carries a copy, because the constant is
 * module-private in both files and neither validator imports the other's
 * internals. Both lists are hand-derived from the same cguru-ui/src/pages/
 * listing, so a page added to one and not the other silently opens a gap: an
 * entity slug the identity validator rejects could still be claimed by a
 * redirect, or vice versa.
 *
 * WHY THIS IS A SOURCE-PARSE TEST
 * -------------------------------
 * Neither file exports the map, and exporting it from one to import in the
 * other would widen a module surface owned elsewhere. Parsing the two SOURCE
 * files is the only way to compare two unexported constants without changing
 * either module — and it also fails loudly if a refactor renames or reshapes
 * the map literal (the extractor throws instead of comparing empty sets).
 *
 * Only the KEYS are compared. The descriptions intentionally differ:
 * identity-validation.ts cites the src/pages/ file, redirect-validation.ts
 * uses a shorter editor-facing label.
 */

function reservedSegmentKeys(fileName: string): string[] {
  const source = readFileSync(resolve(__dirname, fileName), 'utf8');
  const match = source.match(
    /RESERVED_ROUTE_SEGMENTS = new Map<string, string>\(\[([\s\S]*?)\]\);/,
  );
  if (!match) {
    throw new Error(
      `${fileName} no longer declares RESERVED_ROUTE_SEGMENTS as a ` +
        `"new Map<string, string>([...])" literal — update this extractor ` +
        `alongside the refactor so the drift guard keeps working`,
    );
  }
  return [...match[1]!.matchAll(/\[\s*'([^']+)'\s*,/g)].map((entry) => entry[1]!);
}

describe('reserved route segments', () => {
  it('keeps identity-validation.ts and redirect-validation.ts in step', () => {
    const identityKeys = reservedSegmentKeys('identity-validation.ts');
    const redirectKeys = reservedSegmentKeys('redirect-validation.ts');

    // Sanity: the extractor found real entries, not an empty or partial match.
    expect(identityKeys.length).toBeGreaterThan(10);
    expect(new Set(identityKeys).size).toBe(identityKeys.length);
    expect(new Set(redirectKeys).size).toBe(redirectKeys.length);

    // Sorted arrays rather than Sets so a failure prints the exact diff.
    expect([...redirectKeys].sort()).toEqual([...identityKeys].sort());
  });
});
