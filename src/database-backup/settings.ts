import type { Core } from '@strapi/strapi';
import { z } from 'zod';

import {
  BACKUP_DELETE_AFTER_DAYS_MAX,
  BACKUP_INTERVAL_HOURS,
  BACKUP_SETTINGS_DEFAULTS,
  type BackupSettings,
} from '../constants/database-backup';
import { DATABASE_BACKUP_STORE, RUNNER_STORE_KEY, SETTINGS_STORE_KEY } from './constants';

/**
 * Operational knobs a Super Admin edits in the settings page. Stored in the
 * core store so every container (admin, runner) reads the same row; the
 * runner re-reads it every tick, so a change applies without a restart.
 * Credentials are NOT here — see `config.ts`.
 */

const intervalSchema = z.union(
  BACKUP_INTERVAL_HOURS.map((hours) => z.literal(hours)) as unknown as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
);

const settingsSchema = z.object({
  scheduleEnabled: z.boolean(),
  intervalHours: intervalSchema,
  deleteAfterDays: z
    .number()
    .int()
    .min(1)
    .max(BACKUP_DELETE_AFTER_DAYS_MAX)
    .nullable(),
  autoVerify: z.boolean(),
  alertEmail: z
    .string()
    .trim()
    .email()
    .max(254)
    .nullable(),
});

export type SettingsParse =
  | { ok: true; value: BackupSettings }
  | { ok: false; problems: string[] };

/** Validate a full settings object (the page always submits every field). */
export function parseBackupSettings(input: unknown): SettingsParse {
  const candidate: Record<string, unknown> =
    input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {};
  if (candidate.alertEmail === '') candidate.alertEmail = null;
  if (candidate.deleteAfterDays === '' || candidate.deleteAfterDays === undefined) {
    candidate.deleteAfterDays = null;
  }
  const result = settingsSchema.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map((issue) => {
        const path = issue.path.join('.') || 'settings';
        return `${path}: ${issue.message}`;
      }),
    };
  }
  return { ok: true, value: result.data as BackupSettings };
}

function settingsStore(strapi: Core.Strapi) {
  return strapi.store(DATABASE_BACKUP_STORE);
}

/** Stored settings merged over the defaults, so a new field never reads as `undefined`. */
export async function readBackupSettings(strapi: Core.Strapi): Promise<BackupSettings> {
  const stored = await settingsStore(strapi).get({ key: SETTINGS_STORE_KEY });
  const parsed = parseBackupSettings({ ...BACKUP_SETTINGS_DEFAULTS, ...(stored as object ?? {}) });
  return parsed.ok ? parsed.value : { ...BACKUP_SETTINGS_DEFAULTS };
}

export async function writeBackupSettings(
  strapi: Core.Strapi,
  value: BackupSettings,
): Promise<BackupSettings> {
  await settingsStore(strapi).set({ key: SETTINGS_STORE_KEY, value });
  return value;
}

/** What the runner last reported about itself; read by the admin container. */
export type RunnerRecord = {
  workerId: string;
  state: 'running' | 'idle' | 'disabled' | 'misconfigured';
  heartbeatAt: string;
  pgDumpVersion: string | null;
  serverVersion: string | null;
  problems: string[];
  lastStaleAlertAt: string | null;
};

export async function readRunnerRecord(strapi: Core.Strapi): Promise<RunnerRecord | null> {
  const stored = await settingsStore(strapi).get({ key: RUNNER_STORE_KEY });
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Partial<RunnerRecord>;
  if (typeof record.workerId !== 'string' || typeof record.heartbeatAt !== 'string') return null;
  return {
    workerId: record.workerId,
    state: (['running', 'idle', 'disabled', 'misconfigured'] as const).includes(record.state as any)
      ? (record.state as RunnerRecord['state'])
      : 'idle',
    heartbeatAt: record.heartbeatAt,
    pgDumpVersion: typeof record.pgDumpVersion === 'string' ? record.pgDumpVersion : null,
    serverVersion: typeof record.serverVersion === 'string' ? record.serverVersion : null,
    problems: Array.isArray(record.problems) ? record.problems.map(String) : [],
    lastStaleAlertAt: typeof record.lastStaleAlertAt === 'string' ? record.lastStaleAlertAt : null,
  };
}

export async function writeRunnerRecord(strapi: Core.Strapi, record: RunnerRecord): Promise<void> {
  await settingsStore(strapi).set({ key: RUNNER_STORE_KEY, value: record });
}
