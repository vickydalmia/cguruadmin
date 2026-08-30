import { describe, expect, it } from 'vitest';

import {
  REDIRECT_RESERVED_ROUTE_LABELS,
  RESERVED_ROUTE_SEGMENTS,
} from './reserved-route-segments';

/**
 * The reserved-route key set exists twice inside reserved-route-segments.ts —
 * one map per consumer, because the VALUES deliberately differ
 * (identity-validation.ts messages cite the src/pages/ file,
 * redirect-validation.ts uses a shorter editor-facing label) while the KEYS
 * must stay identical. Both are hand-derived from the same
 * cguru-ui/src/pages/ listing, so a page added to one and not the other
 * silently opens a gap: an entity slug the identity validator rejects could
 * still be claimed by a redirect, or vice versa.
 *
 * This used to be a source-parse test (the maps were module-private copies in
 * two files); the shared module exports both, so the guard now compares them
 * directly.
 */
describe('reserved route segments', () => {
  it('reserves content-language prefixes before a locale is enabled', () => {
    expect(RESERVED_ROUTE_SEGMENTS.get('ar')).toMatch(/Arabic content-language/);
    expect(REDIRECT_RESERVED_ROUTE_LABELS.has('ar')).toBe(true);
  });

  it('keeps the identity and redirect key sets in step', () => {
    const identityKeys = [...RESERVED_ROUTE_SEGMENTS.keys()];
    const redirectKeys = [...REDIRECT_RESERVED_ROUTE_LABELS.keys()];

    // Sanity: real entries, no duplicates hidden by Map construction.
    expect(identityKeys.length).toBeGreaterThan(10);

    // Sorted arrays rather than Sets so a failure prints the exact diff.
    expect([...redirectKeys].sort()).toEqual([...identityKeys].sort());
  });

  it('labels every reserved segment for both consumers', () => {
    for (const [key, label] of RESERVED_ROUTE_SEGMENTS) {
      expect(label.trim(), `identity label for "${key}"`).not.toBe('');
      expect(
        REDIRECT_RESERVED_ROUTE_LABELS.get(key)?.trim(),
        `redirect label for "${key}"`,
      ).toBeTruthy();
    }
  });
});
