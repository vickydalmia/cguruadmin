import { describe, expect, it, vi } from 'vitest';

import { BACKUP_SETTINGS_DEFAULTS } from '../constants/database-backup';
import { parseBackupSettings, readBackupSettings, readRunnerRecord, writeBackupSettings } from './settings';

describe('parseBackupSettings', () => {
  it('accepts a full valid object and normalises blanks to null', () => {
    const parsed = parseBackupSettings({
      scheduleEnabled: true, intervalHours: 6, deleteAfterDays: '', autoVerify: false, alertEmail: '',
    });
    expect(parsed).toEqual({ ok: true, value: { ...BACKUP_SETTINGS_DEFAULTS, deleteAfterDays: null } });
  });

  it('reports every problem with its field', () => {
    const parsed = parseBackupSettings({
      scheduleEnabled: 'yes', intervalHours: 5, deleteAfterDays: 0, autoVerify: true, alertEmail: 'not-an-email',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.problems.join('\n')).toContain('scheduleEnabled');
      expect(parsed.problems.join('\n')).toContain('intervalHours');
      expect(parsed.problems.join('\n')).toContain('deleteAfterDays');
      expect(parsed.problems.join('\n')).toContain('alertEmail');
    }
  });

  it('trims the alert email', () => {
    const parsed = parseBackupSettings({ ...BACKUP_SETTINGS_DEFAULTS, alertEmail: '  ops@example.com ' });
    expect(parsed.ok && parsed.value.alertEmail).toBe('ops@example.com');
  });
});

function strapiWithStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const store = {
    get: vi.fn(async ({ key }: { key: string }) => data.get(key) ?? null),
    set: vi.fn(async ({ key, value }: { key: string; value: unknown }) => void data.set(key, value)),
  };
  return { strapi: { store: vi.fn(() => store) } as any, store, data };
}

describe('readBackupSettings / writeBackupSettings', () => {
  it('merges stored values over the defaults and falls back when the row is corrupt', async () => {
    const { strapi } = strapiWithStore({ settings: { intervalHours: 12 } });
    expect(await readBackupSettings(strapi)).toEqual({ ...BACKUP_SETTINGS_DEFAULTS, intervalHours: 12 });
    const broken = strapiWithStore({ settings: { intervalHours: 5 } });
    expect(await readBackupSettings(broken.strapi)).toEqual(BACKUP_SETTINGS_DEFAULTS);
  });

  it('round-trips through the plugin store slot', async () => {
    const { strapi, store } = strapiWithStore();
    await writeBackupSettings(strapi, { ...BACKUP_SETTINGS_DEFAULTS, scheduleEnabled: false });
    expect(store.set).toHaveBeenCalledWith({ key: 'settings', value: { ...BACKUP_SETTINGS_DEFAULTS, scheduleEnabled: false } });
    expect(strapi.store).toHaveBeenCalledWith({ type: 'plugin', name: 'database-backup' });
  });
});

describe('readRunnerRecord', () => {
  it('returns null for missing or malformed records and normalises a good one', async () => {
    expect(await readRunnerRecord(strapiWithStore().strapi)).toBeNull();
    expect(await readRunnerRecord(strapiWithStore({ runner: { state: 'idle' } }).strapi)).toBeNull();
    const record = await readRunnerRecord(strapiWithStore({
      runner: { workerId: 'w1', state: 'bogus', heartbeatAt: '2026-09-06T12:00:00.000Z', problems: [1] },
    }).strapi);
    expect(record).toEqual({
      workerId: 'w1', state: 'idle', heartbeatAt: '2026-09-06T12:00:00.000Z', pgDumpVersion: null,
      serverVersion: null, problems: ['1'], lastStaleAlertAt: null,
    });
  });
});
