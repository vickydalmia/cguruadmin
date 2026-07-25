import { describe, expect, it } from 'vitest';

import {
  fieldWriteForEndMode,
  fieldWriteForStartMode,
  pendingDateFields,
  seedModes,
  STATUS_LABEL,
  STATUS_VARIANT,
} from './publishing-panel';

const FUTURE = '2026-09-01T00:00:00.000Z';

describe('seedModes', () => {
  it('reads a bare offer as immediate and never-expiring', () => {
    expect(seedModes({})).toEqual({ start: 'now', end: 'never' });
  });

  it('reads stored dates as the date-bearing modes', () => {
    expect(seedModes({ scheduledAt: FUTURE, expiresAt: FUTURE })).toEqual({
      start: 'later',
      end: 'date',
    });
  });

  // The two questions are independent — the whole reason for two radios.
  it('seeds the two modes independently', () => {
    expect(seedModes({ scheduledAt: FUTURE })).toEqual({ start: 'later', end: 'never' });
    expect(seedModes({ expiresAt: FUTURE })).toEqual({ start: 'now', end: 'date' });
  });

  it('treats null and empty string as no date', () => {
    expect(seedModes({ scheduledAt: null, expiresAt: '' })).toEqual({
      start: 'now',
      end: 'never',
    });
  });
});

describe('field writes on a radio change', () => {
  // Without the clear, "Publish immediately" would leave a stale future
  // scheduledAt behind and the offer would silently stay scheduled.
  it('clears the date when switching away from it', () => {
    expect(fieldWriteForStartMode('now')).toEqual({ scheduledAt: null });
    expect(fieldWriteForEndMode('never')).toEqual({ expiresAt: null });
  });

  it('writes nothing when revealing a picker for the editor to fill', () => {
    expect(fieldWriteForStartMode('later')).toBeNull();
    expect(fieldWriteForEndMode('date')).toBeNull();
  });
});

describe('pendingDateFields', () => {
  it('reports nothing when every revealed picker has a value', () => {
    expect(
      pendingDateFields({ start: 'later', end: 'date' }, { scheduledAt: FUTURE, expiresAt: FUTURE })
    ).toEqual([]);
    expect(pendingDateFields({ start: 'now', end: 'never' }, {})).toEqual([]);
  });

  it('names each revealed-but-empty picker', () => {
    expect(pendingDateFields({ start: 'later', end: 'date' }, {})).toEqual([
      'Goes live',
      'Ends',
    ]);
    expect(
      pendingDateFields({ start: 'later', end: 'never' }, { scheduledAt: null })
    ).toEqual(['Goes live']);
  });

  it('ignores a stored date the editor has switched away from', () => {
    expect(
      pendingDateFields({ start: 'now', end: 'never' }, { scheduledAt: FUTURE })
    ).toEqual([]);
  });
});

describe('status presentation', () => {
  it('covers every derived lifecycle state', () => {
    for (const status of ['published', 'scheduled', 'expired']) {
      expect(STATUS_VARIANT[status]).toBeTruthy();
      expect(STATUS_LABEL[status]).toBeTruthy();
    }
  });
});
