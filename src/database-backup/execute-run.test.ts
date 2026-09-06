import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stampRunTarget: vi.fn(async () => true),
  heartbeatRun: vi.fn(async () => ({ owned: true, cancelRequested: false })),
  finishRun: vi.fn(async () => true),
  failRun: vi.fn(async () => true),
  releaseForRetry: vi.fn(async () => 'pending' as const),
  finishVerify: vi.fn(async () => undefined),
  releaseVerify: vi.fn(async () => undefined),
  heartbeatVerify: vi.fn(async () => true),
  getRunRow: vi.fn(async () => ({ id: 'run-1', status: 'failed', error: 'boom', trigger: 'manual', attempt_count: 1 })),
  uploadArchive: vi.fn(),
  abortMultipartUploads: vi.fn(async () => 0),
  deleteBackupObject: vi.fn(async () => undefined),
  applyRetention: vi.fn(async () => ({ deleted: 0, failed: 0 })),
  sendBackupFailureAlert: vi.fn(async () => undefined),
  spawnPgDump: vi.fn(),
  verifyArchive: vi.fn(),
}));

vi.mock('./store', () => ({
  stampRunTarget: mocks.stampRunTarget,
  heartbeatRun: mocks.heartbeatRun,
  finishRun: mocks.finishRun,
  failRun: mocks.failRun,
  releaseForRetry: mocks.releaseForRetry,
  finishVerify: mocks.finishVerify,
  releaseVerify: mocks.releaseVerify,
  heartbeatVerify: mocks.heartbeatVerify,
}));
vi.mock('./store-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store-rows')>()),
  getRunRow: mocks.getRunRow,
}));
vi.mock('./s3-upload', () => ({ uploadArchive: mocks.uploadArchive }));
vi.mock('./s3-objects', () => ({ abortMultipartUploads: mocks.abortMultipartUploads, deleteBackupObject: mocks.deleteBackupObject }));
vi.mock('./retention', () => ({ applyRetention: mocks.applyRetention }));
vi.mock('./alerts', () => ({ sendBackupFailureAlert: mocks.sendBackupFailureAlert }));
vi.mock('./pg-dump', () => ({ spawnPgDump: mocks.spawnPgDump }));
vi.mock('./verify', () => ({ verifyArchive: mocks.verifyArchive }));

import { BACKUP_SETTINGS_DEFAULTS } from '../constants/database-backup';
import { RUN_HEARTBEAT_MS, VERIFY_TIMEOUT_MS } from './constants';
import { launchBackup, launchVerify, type RunnerContext } from './execute-run';

function fakeDump() {
  const archive = Object.assign(new PassThrough(), { bytes: 4096, sha256: 'abc' });
  let resolveExit: (value: any) => void = () => undefined;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  return {
    archive,
    exited,
    kill: vi.fn(() => resolveExit({ code: null, signal: 'SIGTERM', spawnError: null, stderrTail: '' })),
    finish: () => resolveExit({ code: 0, signal: null, spawnError: null, stderrTail: '' }),
    child: {},
  };
}

const logs: string[] = [];
const ctx: RunnerContext = {
  strapi: { log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } } as any,
  config: {
    runnerEnabled: true, countryCode: 'IN',
    s3: { bucket: 'backups', region: 'r', prefix: 'db', accessKeyId: 'k', secretAccessKey: 'hunter2', endpoint: null, forcePathStyle: false, sse: 'AES256', kmsKeyId: null },
    timeoutMinutes: 60, pgDumpPath: 'pg_dump', pgRestorePath: 'pg_restore', compression: 'zstd:3',
  },
  client: {} as any,
  invocation: { childEnv: { PGPASSWORD: 'pw' }, dumpArgs: ['--format=custom'], ssl: { mode: 'prefer' }, caPem: null, caPath: null, secrets: ['pw'] },
  versions: { pgDump: '18.6', server: '18.1' },
};
const claim = { id: 'run-1', lockToken: 'tok', row: { id: 'run-1', trigger: 'manual', attempt_count: 1 } };

beforeEach(() => {
  logs.length = 0;
  vi.clearAllMocks();
});

describe('launchBackup', () => {
  it('finishes the row with the upload result and runs retention on success', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    mocks.uploadArchive.mockImplementation(async () => {
      dump.finish();
      return { bytes: 4096, sha256: 'abc', etag: '"e"' };
    });
    const job = launchBackup(ctx, claim as any, { ...BACKUP_SETTINGS_DEFAULTS, autoVerify: true });
    await job.done;

    expect(mocks.stampRunTarget).toHaveBeenCalledWith(ctx.strapi, 'run-1', 'tok', expect.objectContaining({
      s3_bucket: 'backups', pg_dump_version: '18.6', server_version: '18.1',
    }));
    const key = mocks.stampRunTarget.mock.calls[0][3].s3_key;
    expect(key).toMatch(/^db\/IN\/\d{4}\/\d{2}\/\d{2}\/IN-strapi-\d{8}T\d{6}Z-run1\.dump$/);
    expect(mocks.finishRun).toHaveBeenCalledWith(ctx.strapi, 'run-1', 'tok', expect.objectContaining({
      s3_key: key, size_bytes: 4096, sha256: 'abc', etag: '"e"', verify_state: 'pending',
    }));
    expect(mocks.applyRetention).toHaveBeenCalledTimes(1);
    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('"backup.succeeded"'))).toBe(true);
  });

  it('marks the row failed, aborts the multipart, redacts secrets, and alerts on error', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    mocks.uploadArchive.mockRejectedValue(new Error('pg_dump exited with code 1: FATAL password pw rejected'));
    const job = launchBackup(ctx, claim as any, { ...BACKUP_SETTINGS_DEFAULTS, alertEmail: 'ops@example.com' });
    await job.done;

    expect(dump.kill).toHaveBeenCalled();
    expect(mocks.abortMultipartUploads).toHaveBeenCalledTimes(1);
    expect(mocks.failRun).toHaveBeenCalledWith(ctx.strapi, 'run-1', 'tok', 'pg_dump exited with code 1: FATAL password *** rejected');
    expect(mocks.sendBackupFailureAlert).toHaveBeenCalledWith(ctx.strapi, 'ops@example.com', expect.objectContaining({ id: 'run-1' }), 'IN');
    expect(mocks.finishRun).not.toHaveBeenCalled();
  });

  it('deletes an archive that was committed before a later step failed', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    // Multipart completed; the size check after it did not.
    mocks.uploadArchive.mockRejectedValue(new Error('uploaded object size 10 does not match streamed 4096 bytes'));
    await launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS).done;

    const key = mocks.stampRunTarget.mock.calls[0][3].s3_key;
    expect(mocks.abortMultipartUploads).toHaveBeenCalledWith(ctx.client, 'backups', key);
    expect(mocks.deleteBackupObject).toHaveBeenCalledWith(ctx.client, 'backups', key);
    expect(mocks.failRun).toHaveBeenCalledWith(ctx.strapi, 'run-1', 'tok', 'uploaded object size 10 does not match streamed 4096 bytes');
  });

  it('discards its own archive when the lease was lost and the row moved on', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    mocks.uploadArchive.mockImplementation(async () => { dump.finish(); return { bytes: 4096, sha256: 'abc', etag: '"e"' }; });
    mocks.finishRun.mockResolvedValueOnce(false);
    // The reclaim handed the row back and the retry runs under a new key.
    mocks.getRunRow.mockResolvedValueOnce({ id: 'run-1', status: 'running', s3_key: 'db/IN/other.dump' } as any);
    await launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS).done;

    const key = mocks.stampRunTarget.mock.calls[0][3].s3_key;
    expect(mocks.deleteBackupObject).toHaveBeenCalledWith(ctx.client, 'backups', key);
    expect(mocks.applyRetention).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('"backup.lease_lost"'))).toBe(true);
  });

  // A worker paused past the stale cutoff may finish its upload after the
  // reclaim already reconciled that key into a success: the archive stays.
  it('keeps an archive the reclaim reconciled under this very key', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    mocks.uploadArchive.mockImplementation(async () => { dump.finish(); return { bytes: 4096, sha256: 'abc', etag: '"e"' }; });
    mocks.finishRun.mockResolvedValueOnce(false);
    mocks.getRunRow.mockImplementationOnce(async () => ({
      id: 'run-1', status: 'succeeded', s3_key: mocks.stampRunTarget.mock.calls[0][3].s3_key,
    }) as any);
    await launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS).done;

    expect(mocks.deleteBackupObject).not.toHaveBeenCalled();
    expect(mocks.abortMultipartUploads).not.toHaveBeenCalled();
    const skipped = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === 'backup.cleanup_skipped');
    expect(skipped).toMatchObject({ runId: 'run-1', reason: 'archive reconciled as succeeded' });
  });

  it('logs the key when the cleanup itself fails so an operator can remove it', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    mocks.uploadArchive.mockRejectedValue(new Error('sidecar upload failed'));
    mocks.deleteBackupObject.mockRejectedValueOnce(new Error('AccessDenied'));
    await launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS).done;

    const cleanup = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === 'backup.cleanup_failed');
    expect(cleanup).toMatchObject({ runId: 'run-1', error: 'AccessDenied' });
    expect(cleanup.key).toMatch(/\.dump$/);
    expect(mocks.failRun).toHaveBeenCalled();
  });

  it('hands the row back for retry when stopped for a shutdown', async () => {
    const dump = fakeDump();
    mocks.spawnPgDump.mockReturnValue(dump);
    mocks.uploadArchive.mockImplementation((input: any) => new Promise((_resolve, reject) => {
      input.abortSignal.addEventListener('abort', () => reject(new Error('Request aborted')));
    }));
    const job = launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS);
    await new Promise((resolve) => setTimeout(resolve, 5));
    job.stop('shutdown');
    await job.done;

    expect(dump.kill).toHaveBeenCalled();
    expect(mocks.releaseForRetry).toHaveBeenCalledWith(ctx.strapi, 'run-1', 'tok', 1, 'interrupted by a restart; retrying');
    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(mocks.sendBackupFailureAlert).not.toHaveBeenCalled();
  });

  it('records a cancellation when the heartbeat sees the cancel flag', async () => {
    vi.useFakeTimers();
    try {
      const dump = fakeDump();
      mocks.spawnPgDump.mockReturnValue(dump);
      mocks.heartbeatRun.mockResolvedValue({ owned: true, cancelRequested: true });
      mocks.uploadArchive.mockImplementation((input: any) => new Promise((_resolve, reject) => {
        input.abortSignal.addEventListener('abort', () => reject(new Error('Request aborted')));
      }));
      const job = launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS);
      await vi.advanceTimersByTimeAsync(16_000);
      await job.done;
      expect(mocks.failRun).toHaveBeenCalledWith(ctx.strapi, 'run-1', 'tok', 'cancelled by an administrator', 'cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up without touching the row when the lease was lost at start', async () => {
    mocks.stampRunTarget.mockResolvedValueOnce(false);
    const job = launchBackup(ctx, claim as any, BACKUP_SETTINGS_DEFAULTS);
    await job.done;
    expect(mocks.spawnPgDump).not.toHaveBeenCalled();
    expect(mocks.failRun).not.toHaveBeenCalled();
  });
});

describe('launchVerify', () => {
  it('stores the table-of-contents count on success and the error on failure', async () => {
    mocks.verifyArchive.mockResolvedValueOnce({ ok: true, tocEntries: 42 });
    await launchVerify(ctx, { id: 'run-1', s3_key: 'db/x.dump', s3_bucket: 'old-bucket' }).done;
    expect(mocks.finishVerify).toHaveBeenCalledWith(ctx.strapi, 'run-1', { ok: true, tocEntries: 42 });
    // The archive lives in the bucket recorded on the run, not today's config.
    expect(mocks.verifyArchive).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'old-bucket', key: 'db/x.dump' }));

    mocks.verifyArchive.mockResolvedValueOnce({ ok: false, error: 'bad archive pw' });
    await launchVerify(ctx, { id: 'run-2', s3_key: 'db/y.dump' }).done;
    expect(mocks.finishVerify).toHaveBeenCalledWith(ctx.strapi, 'run-2', { ok: false, error: 'bad archive ***' });
  });

  it('stops a verification whose lease was reclaimed and records nothing', async () => {
    vi.useFakeTimers();
    try {
      mocks.heartbeatVerify.mockResolvedValueOnce(false);
      mocks.verifyArchive.mockImplementationOnce(
        ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise((resolve) => abortSignal.addEventListener('abort', () => resolve({ ok: false, error: 'killed' }))),
      );
      const job = launchVerify(ctx, { id: 'run-4', s3_key: 'db/z.dump' });
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_MS + 1);
      await job.done;
      expect(mocks.heartbeatVerify).toHaveBeenCalledWith(ctx.strapi, 'run-4');
      expect(mocks.finishVerify).not.toHaveBeenCalledWith(ctx.strapi, 'run-4', expect.anything());
      expect(mocks.releaseVerify).not.toHaveBeenCalledWith(ctx.strapi, 'run-4');
      expect(logs.some((line) => line.includes('backup.verify_lease_lost'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a verification that outlives its deadline so the runner is freed', async () => {
    vi.useFakeTimers();
    try {
      mocks.verifyArchive.mockImplementationOnce(
        ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise((resolve) => abortSignal.addEventListener('abort', () => resolve({ ok: false, error: 'killed' }))),
      );
      const job = launchVerify(ctx, { id: 'run-5', s3_key: 'db/slow.dump' });
      await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
      await job.done;
      expect(mocks.finishVerify).toHaveBeenCalledWith(ctx.strapi, 'run-5', { ok: false, error: 'verification exceeded 10 minutes' });
      expect(mocks.releaseVerify).not.toHaveBeenCalledWith(ctx.strapi, 'run-5');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a run that has no stored key without calling pg_restore', async () => {
    await launchVerify(ctx, { id: 'run-3', s3_key: null }).done;
    expect(mocks.verifyArchive).not.toHaveBeenCalled();
    expect(mocks.finishVerify).toHaveBeenCalledWith(ctx.strapi, 'run-3', { ok: false, error: 'the run has no stored object key' });
  });
});
