import type { BackupSettings } from '../constants/database-backup';

/**
 * Pure schedule arithmetic. A "slot" is the start of an interval-aligned UTC
 * window: with 6 h that is 00:00, 06:00, 12:00, 18:00 UTC. Every allowed
 * interval divides 24, so slots stay aligned to UTC midnight and never drift.
 *
 * Only the CURRENT slot is ever considered, which gives exactly one catch-up
 * run after downtime instead of one per missed window.
 */

const HOUR_MS = 60 * 60 * 1_000;

export function intervalMs(intervalHours: number): number {
  return intervalHours * HOUR_MS;
}

/** Start of the slot that contains `now`. */
export function currentSlot(now: Date, intervalHours: number): Date {
  const size = intervalMs(intervalHours);
  return new Date(Math.floor(now.getTime() / size) * size);
}

export type SlotSatisfiedInput = {
  slot: Date;
  /** A scheduled row (any status but cancelled) already exists for this slot. */
  slotRowExists: boolean;
  /** Start time of the most recent succeeded run, manual or scheduled. */
  lastSuccessStartedAt: Date | null;
};

/**
 * A slot needs no run when it was already enqueued, or when any successful
 * backup (a manual one included) started inside it — a "Back up now" at 12:05
 * replaces the 12:00 scheduled run.
 */
export function isSlotSatisfied(input: SlotSatisfiedInput): boolean {
  if (input.slotRowExists) return true;
  return input.lastSuccessStartedAt !== null
    && input.lastSuccessStartedAt.getTime() >= input.slot.getTime();
}

export type NextRunInput = {
  settings: Pick<BackupSettings, 'scheduleEnabled' | 'intervalHours'>;
  now: Date;
  currentSlotSatisfied: boolean;
};

/** When the admin should expect the next automatic backup; `null` when off. */
export function nextScheduledRunAt(input: NextRunInput): Date | null {
  if (!input.settings.scheduleEnabled) return null;
  const slot = currentSlot(input.now, input.settings.intervalHours);
  if (!input.currentSlotSatisfied) return input.now;
  return new Date(slot.getTime() + intervalMs(input.settings.intervalHours));
}

/** No success for longer than two intervals plus a grace period = stale. */
export function isBackupStale(input: {
  settings: Pick<BackupSettings, 'scheduleEnabled' | 'intervalHours'>;
  now: Date;
  lastSuccessAt: Date | null;
  /** When the schedule was (re)enabled or the first run was possible. */
  since: Date | null;
}): boolean {
  if (!input.settings.scheduleEnabled) return false;
  const allowance = 2 * intervalMs(input.settings.intervalHours) + 30 * 60_000;
  const reference = input.lastSuccessAt ?? input.since;
  if (!reference) return false;
  return input.now.getTime() - reference.getTime() > allowance;
}
