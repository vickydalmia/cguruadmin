import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteBackupObject: vi.fn(async () => undefined),
  markDeleted: vi.fn(async () => true),
  succeededRunRows: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  pruneHistoryRows: vi.fn(async () => 0),
}));
vi.mock('./s3-objects', () => ({ deleteBackupObject: mocks.deleteBackupObject }));
vi.mock('./store', () => ({ markDeleted: mocks.markDeleted }));
vi.mock('./store-rows', () => ({ succeededRunRows: mocks.succeededRunRows, pruneHistoryRows: mocks.pruneHistoryRows }));
vi.mock('./log', () => ({ logDatabaseBackup: vi.fn() }));

import { applyRetention, selectRunsToDelete, type RetentionCandidate } from './retention';

const day = 24 * 60 * 60_000;
const now = new Date('2026-09-10T00:00:00Z');
const run = (id: string, daysAgo: number): RetentionCandidate => ({
  id, startedAt: new Date(now.getTime() - daysAgo * day), s3Key: `k/${id}`, s3Bucket: null,
});

describe('selectRunsToDelete', () => {
  it('does nothing when retention is off', () => {
    expect(selectRunsToDelete([run('a', 100)], { deleteAfterDays: null, now })).toEqual([]);
  });

  it('deletes only runs older than the limit and keeps the newest three whatever their age', () => {
    const candidates = [run('old1', 30), run('old2', 20), run('old3', 10), run('old4', 9), run('new', 1)];
    expect(selectRunsToDelete(candidates, { deleteAfterDays: 7, now }).map((r) => r.id)).toEqual(['old2', 'old1']);
    // Five runs all older than the limit: three survive.
    const allOld = [run('a', 50), run('b', 40), run('c', 30), run('d', 20), run('e', 10)];
    expect(selectRunsToDelete(allOld, { deleteAfterDays: 7, now }).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('respects the day boundary exactly', () => {
    const candidates = [run('x', 0), run('y', 0.5), run('z', 1), run('edge', 7), run('past', 7.01)];
    expect(selectRunsToDelete(candidates, { deleteAfterDays: 7, now }).map((r) => r.id)).toEqual(['past']);
  });

  it('never selects a run without a start time', () => {
    const candidates = [run('a', 1), run('b', 2), run('c', 3), { id: 'd', startedAt: null, s3Key: 'k/d', s3Bucket: null }];
    expect(selectRunsToDelete(candidates, { deleteAfterDays: 1, now })).toEqual([]);
  });
});

describe('applyRetention', () => {
  beforeEach(() => {
    mocks.deleteBackupObject.mockClear();
    mocks.markDeleted.mockClear();
  });

  it('deletes each archive from the bucket it was written to', async () => {
    const rowAt = (id: string, daysAgo: number, bucket: string | null) => ({
      id, started_at: new Date(now.getTime() - daysAgo * day), s3_key: `k/${id}`, s3_bucket: bucket,
    });
    mocks.succeededRunRows.mockResolvedValueOnce([
      rowAt('new1', 1, 'current'), rowAt('new2', 2, 'current'), rowAt('new3', 3, 'current'),
      rowAt('moved', 30, 'previous-bucket'), rowAt('legacy', 40, null),
    ]);
    const client = {} as any;
    const result = await applyRetention({} as any, client, 'current', { deleteAfterDays: 7 }, now);
    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(mocks.deleteBackupObject.mock.calls).toEqual([
      [client, 'previous-bucket', 'k/moved'],
      [client, 'current', 'k/legacy'],
    ]);
    expect(mocks.markDeleted.mock.calls.map((call) => call[1])).toEqual(['moved', 'legacy']);
  });
});
