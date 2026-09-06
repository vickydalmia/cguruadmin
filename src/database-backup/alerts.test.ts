import { describe, expect, it } from 'vitest';

import { staleBackupAlertDue } from './alerts';

describe('staleBackupAlertDue', () => {
  const now = new Date('2026-09-06T12:00:00Z');

  it('never alerts when not stale', () => {
    expect(staleBackupAlertDue({ now, stale: false, lastAlertAt: null })).toBe(false);
  });

  it('alerts once, then at most once a day', () => {
    expect(staleBackupAlertDue({ now, stale: true, lastAlertAt: null })).toBe(true);
    expect(staleBackupAlertDue({ now, stale: true, lastAlertAt: new Date('2026-09-05T13:00:00Z') })).toBe(false);
    expect(staleBackupAlertDue({ now, stale: true, lastAlertAt: new Date('2026-09-05T12:00:00Z') })).toBe(true);
  });
});
