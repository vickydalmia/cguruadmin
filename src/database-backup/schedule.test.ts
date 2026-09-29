import { describe, expect, it } from 'vitest';

import { currentSlot, isBackupStale, isSlotSatisfied, nextScheduledRunAt } from './schedule';

const at = (iso: string) => new Date(iso);

describe('currentSlot', () => {
  it('aligns to UTC boundaries for every allowed interval', () => {
    expect(currentSlot(at('2026-09-06T13:47:00Z'), 6).toISOString()).toBe('2026-09-06T12:00:00.000Z');
    expect(currentSlot(at('2026-09-06T23:59:59Z'), 6).toISOString()).toBe('2026-09-06T18:00:00.000Z');
    expect(currentSlot(at('2026-09-06T00:00:00Z'), 6).toISOString()).toBe('2026-09-06T00:00:00.000Z');
    expect(currentSlot(at('2026-09-06T13:47:00Z'), 24).toISOString()).toBe('2026-09-06T00:00:00.000Z');
    expect(currentSlot(at('2026-09-06T13:47:00Z'), 1).toISOString()).toBe('2026-09-06T13:00:00.000Z');
    expect(currentSlot(at('2026-09-06T13:47:00Z'), 8).toISOString()).toBe('2026-09-06T08:00:00.000Z');
  });
});

describe('isSlotSatisfied', () => {
  const slot = at('2026-09-06T12:00:00Z');

  it('is satisfied by an existing scheduled row for the slot', () => {
    expect(isSlotSatisfied({ slot, slotRowExists: true, lastSuccessStartedAt: null })).toBe(true);
  });

  it('is satisfied by any success that started inside the slot (manual included)', () => {
    expect(isSlotSatisfied({ slot, slotRowExists: false, lastSuccessStartedAt: at('2026-09-06T12:05:00Z') })).toBe(true);
    expect(isSlotSatisfied({ slot, slotRowExists: false, lastSuccessStartedAt: at('2026-09-06T12:00:00Z') })).toBe(true);
  });

  it('is not satisfied by an older success or no success at all', () => {
    expect(isSlotSatisfied({ slot, slotRowExists: false, lastSuccessStartedAt: at('2026-09-06T11:59:59Z') })).toBe(false);
    expect(isSlotSatisfied({ slot, slotRowExists: false, lastSuccessStartedAt: null })).toBe(false);
  });
});

describe('nextScheduledRunAt', () => {
  const settings = { scheduleEnabled: true, intervalHours: 6 as const };

  it('is null when the schedule is off', () => {
    expect(nextScheduledRunAt({ settings: { ...settings, scheduleEnabled: false }, now: at('2026-09-06T13:00:00Z'), currentSlotSatisfied: false })).toBeNull();
  });

  it('is "now" when the current slot still needs a run (catch-up)', () => {
    const now = at('2026-09-06T13:00:00Z');
    expect(nextScheduledRunAt({ settings, now, currentSlotSatisfied: false })).toEqual(now);
  });

  it('is the next boundary once the current slot is covered', () => {
    expect(nextScheduledRunAt({ settings, now: at('2026-09-06T13:00:00Z'), currentSlotSatisfied: true })?.toISOString())
      .toBe('2026-09-06T18:00:00.000Z');
  });
});

describe('isBackupStale', () => {
  const settings = { scheduleEnabled: true, intervalHours: 6 as const };

  it('needs more than two intervals plus thirty minutes without a success', () => {
    const lastSuccessAt = at('2026-09-06T00:00:00Z');
    expect(isBackupStale({ settings, now: at('2026-09-06T12:29:00Z'), lastSuccessAt, since: null })).toBe(false);
    expect(isBackupStale({ settings, now: at('2026-09-06T12:31:00Z'), lastSuccessAt, since: null })).toBe(true);
  });

  it('uses the first attempt as the clock when nothing ever succeeded', () => {
    expect(isBackupStale({ settings, now: at('2026-09-06T13:00:00Z'), lastSuccessAt: null, since: at('2026-09-06T00:00:00Z') })).toBe(true);
    expect(isBackupStale({ settings, now: at('2026-09-06T13:00:00Z'), lastSuccessAt: null, since: null })).toBe(false);
  });

  it('is never stale while the schedule is off', () => {
    expect(isBackupStale({ settings: { ...settings, scheduleEnabled: false }, now: at('2026-09-09T00:00:00Z'), lastSuccessAt: at('2026-09-01T00:00:00Z'), since: null })).toBe(false);
  });
});
