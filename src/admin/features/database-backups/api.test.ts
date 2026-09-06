import { describe, expect, it } from 'vitest';

import type { BackupOverview, BackupRunView } from '../../../constants/database-backup';
import {
  activityInFlight,
  backupError,
  describeTrigger,
  elapsedSince,
  formatBytes,
  formatDuration,
  formatScheduledAt,
  isForbidden,
  runActionPath,
  runsPath,
  unwrapOverview,
  unwrapRun,
  unwrapRuns,
} from './api';

const run = (overrides: Partial<BackupRunView>): BackupRunView => ({
  id: 'r', trigger: 'manual', scheduleSlot: null, requestedById: null, requestedByLabel: null, note: null, status: 'succeeded',
  attemptCount: 1, createdAt: '2026-09-06T12:00:00.000Z', startedAt: null, finishedAt: null, heartbeatAt: null, cancelRequestedAt: null,
  s3Bucket: null, s3Key: null, sizeBytes: null, sha256: null, durationMs: null, pgDumpVersion: null, serverVersion: null, error: null,
  verifyState: null, verifyRequestedAt: null, verifiedAt: null, verifyTocEntries: null, verifyError: null, deletedAt: null, deletedReason: null,
  ...overrides,
});

describe('paths', () => {
  it('targets the admin router prefix', () => {
    expect(runsPath(2, 10)).toBe('/database-backups/runs?page=2&pageSize=10');
    expect(runActionPath('a b', 'verify')).toBe('/database-backups/runs/a%20b/verify');
  });
});

describe('unwrap helpers', () => {
  it('reads the admin envelope and rejects unexpected shapes', () => {
    const overview = { settings: {}, runner: {}, storage: {} } as unknown as BackupOverview;
    expect(unwrapOverview({ data: overview })).toBe(overview);
    expect(() => unwrapOverview({ data: { html: '<html>' } })).toThrow('overview');
    expect(unwrapRuns({ data: { runs: [], page: '2', total: '3', pageCount: 0 } })).toEqual({ runs: [], page: 2, pageSize: 20, total: 3, pageCount: 1 });
    expect(() => unwrapRuns({ data: {} })).toThrow('history');
    expect(unwrapRun({ data: { run: run({ id: 'x' }) } })?.id).toBe('x');
    expect(unwrapRun({ data: {} })).toBeNull();
  });
});

describe('errors', () => {
  it('prefers the validation problem list, then the server message, then the transport message', () => {
    expect(backupError({ response: { data: { error: { details: { problems: ['a', 'b'] }, message: 'm' } } } })).toBe('a b');
    expect(backupError({ response: { data: { error: { message: 'A backup is already in progress.' } } } })).toBe('A backup is already in progress.');
    expect(backupError(new Error('Network Error'))).toBe('Network Error');
    expect(backupError({}, 'fallback')).toBe('fallback');
    expect(isForbidden({ status: 403 })).toBe(true);
    expect(isForbidden({ response: { status: 500 } })).toBe(false);
  });
});

describe('formatters', () => {
  it('formats sizes, durations, and triggers', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(52.4 * 1024 * 1024)).toBe('52 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000 * 2 + 60_000)).toBe('2h 1m');
    expect(describeTrigger({ trigger: 'scheduled', requestedByLabel: null })).toBe('Scheduled');
    expect(describeTrigger({ trigger: 'manual', requestedByLabel: 'Jane <j@x>' })).toBe('On-demand · Jane <j@x>');
    expect(formatScheduledAt('2026-09-06T12:00:00.000Z')).toMatch(/^2026-09-06 12:00 UTC \(.+ local\)$/);
    expect(formatScheduledAt(null)).toBe('—');
    expect(elapsedSince('2026-09-06T12:00:00.000Z', Date.parse('2026-09-06T12:00:30.000Z'))).toBe(30_000);
    expect(elapsedSince(null)).toBeNull();
  });
});

describe('activityInFlight', () => {
  it('is true while a run is active or a verification is queued', () => {
    const idle = { activeRun: null } as unknown as BackupOverview;
    expect(activityInFlight(idle, [run({})])).toBe(false);
    expect(activityInFlight({ activeRun: run({ status: 'running' }) } as unknown as BackupOverview, [])).toBe(true);
    expect(activityInFlight(idle, [run({ verifyState: 'pending' })])).toBe(true);
  });
});
