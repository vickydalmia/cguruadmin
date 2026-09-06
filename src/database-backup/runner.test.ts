import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runBackupPreflight: vi.fn(),
  readBackupSettings: vi.fn(async () => ({ scheduleEnabled: true, intervalHours: 6, deleteAfterDays: 7, autoVerify: false, alertEmail: null })),
  readRunnerRecord: vi.fn(async () => null),
  writeRunnerRecord: vi.fn(async () => undefined),
  createBackupS3Client: vi.fn(() => ({})),
  buildPgInvocation: vi.fn(() => ({ childEnv: {}, caPem: null, caPath: null, ssl: { mode: 'disable' } })),
  removeCaFiles: vi.fn(async () => undefined),
  materialiseCaFile: vi.fn(async () => undefined),
  reclaimStaleRuns: vi.fn(async () => [] as any[]),
  reclaimStaleVerifications: vi.fn(async () => [] as any[]),
  claimNextRun: vi.fn(async () => null),
  claimVerify: vi.fn(async () => null),
  enqueueRun: vi.fn(async () => ({ created: false, row: {} })),
  lastSuccessfulRunRow: vi.fn(async () => ({ started_at: new Date() })),
  oldestRunRow: vi.fn(async () => null),
  scheduledSlotExists: vi.fn(async () => true),
  applyRetention: vi.fn(async () => ({ deleted: 0, failed: 0 })),
  abortMultipartUploads: vi.fn(async () => 0),
  deleteBackupObject: vi.fn(async () => undefined),
  headBackupObject: vi.fn(async () => ({ exists: false, sizeBytes: null, etag: null }) as any),
  readSidecarSha256: vi.fn(async () => null as string | null),
  reconcileRunSucceeded: vi.fn(async () => true),
}));

vi.mock('./preflight', () => ({ runBackupPreflight: mocks.runBackupPreflight }));
vi.mock('./settings', () => ({
  readBackupSettings: mocks.readBackupSettings,
  readRunnerRecord: mocks.readRunnerRecord,
  writeRunnerRecord: mocks.writeRunnerRecord,
}));
vi.mock('./s3-client', () => ({ createBackupS3Client: mocks.createBackupS3Client }));
vi.mock('./pg-connection', () => ({ buildPgInvocation: mocks.buildPgInvocation }));
vi.mock('./pg-dump', () => ({ removeCaFiles: mocks.removeCaFiles, materialiseCaFile: mocks.materialiseCaFile }));
vi.mock('./store', () => ({
  reclaimStaleRuns: mocks.reclaimStaleRuns,
  reclaimStaleVerifications: mocks.reclaimStaleVerifications,
  claimNextRun: mocks.claimNextRun,
  claimVerify: mocks.claimVerify,
  enqueueRun: mocks.enqueueRun,
  reconcileRunSucceeded: mocks.reconcileRunSucceeded,
}));
vi.mock('./store-rows', () => ({
  lastSuccessfulRunRow: mocks.lastSuccessfulRunRow,
  oldestRunRow: mocks.oldestRunRow,
  scheduledSlotExists: mocks.scheduledSlotExists,
}));
vi.mock('./retention', () => ({ applyRetention: mocks.applyRetention }));
vi.mock('./s3-objects', () => ({
  abortMultipartUploads: mocks.abortMultipartUploads,
  deleteBackupObject: mocks.deleteBackupObject,
  headBackupObject: mocks.headBackupObject,
  readSidecarSha256: mocks.readSidecarSha256,
}));

import { initializeBackgroundContext } from '../background/execution-context';
import { resetDatabaseBackupRunnerForTests, startDatabaseBackupRunner } from './runner';

const S3_ENV = ['BACKUP_S3_BUCKET', 'BACKUP_S3_REGION', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_ACCESS_SECRET'];

function fakeStrapi() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log, db: { connection: {} }, dirs: { app: { root: '/tmp' } } } as any;
}

function misconfiguredLogs(strapi: any) {
  return strapi.log.error.mock.calls
    .map(([line]: [string]) => JSON.parse(line))
    .filter((entry: any) => entry.event === 'backup.misconfigured');
}

async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('database backup runner preflight cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initializeBackgroundContext();
    vi.stubEnv('BACKUP_RUNNER_ENABLED', 'true');
    vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', 'IN');
    for (const name of S3_ENV) vi.stubEnv(name, '');
    mocks.runBackupPreflight.mockReset();
  });

  afterEach(() => {
    resetDatabaseBackupRunnerForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('unconfigured runner alerts once at boot and never re-preflights every five minutes', async () => {
    mocks.runBackupPreflight.mockResolvedValue({
      ok: false, problems: ['BACKUP_S3_BUCKET is not set.'], pgDumpVersion: null, pgRestoreVersion: null, serverVersion: null,
    });
    const strapi = fakeStrapi();
    await startDatabaseBackupRunner(strapi);
    await settle(0);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);
    expect(misconfiguredLogs(strapi)).toHaveLength(1);
    expect(misconfiguredLogs(strapi)[0]).toMatchObject({ alert: true, unconfigured: true, problems: ['BACKUP_S3_BUCKET is not set.'] });
    expect(misconfiguredLogs(strapi)[0].message).toMatch(/no backups will run/);

    await settle(6 * 60_000);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);
    expect(misconfiguredLogs(strapi)).toHaveLength(1);
    // The heartbeat keeps reporting "misconfigured" so the admin overview stays truthful.
    expect(mocks.writeRunnerRecord).toHaveBeenCalled();
    expect((mocks.writeRunnerRecord.mock.calls.at(-1) as any)[1]).toMatchObject({ state: 'misconfigured' });

    await settle(24 * 60 * 60_000);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);
    expect(misconfiguredLogs(strapi)).toHaveLength(2);
  });

  it('configured runner with a failing preflight retries every five minutes', async () => {
    for (const name of S3_ENV) vi.stubEnv(name, name === 'BACKUP_S3_REGION' ? 'ap-south-1' : 'value');
    mocks.runBackupPreflight.mockResolvedValue({
      ok: false, problems: ['The backup bucket is not reachable: AccessDenied'], pgDumpVersion: '18.0', pgRestoreVersion: '18.0', serverVersion: '18.0',
    });
    const strapi = fakeStrapi();
    await startDatabaseBackupRunner(strapi);
    await settle(0);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);
    expect(misconfiguredLogs(strapi)[0].unconfigured).toBeUndefined();

    await settle(4 * 60_000);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);
    await settle(2 * 60_000);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(2);
    expect(misconfiguredLogs(strapi)).toHaveLength(2);
  });

  it('never blocks Strapi bootstrap on the bucket and runs one preflight at a time', async () => {
    for (const name of S3_ENV) vi.stubEnv(name, name === 'BACKUP_S3_REGION' ? 'ap-south-1' : 'value');
    let finishPreflight: (value: unknown) => void = () => undefined;
    mocks.runBackupPreflight.mockImplementation(() => new Promise((resolve) => { finishPreflight = resolve; }));
    const strapi = fakeStrapi();
    // A silent endpoint: the preflight is still pending when bootstrap returns.
    await startDatabaseBackupRunner(strapi);
    expect(strapi.log.info.mock.calls.some(([line]: [string]) => line.includes('backup.runner_started'))).toBe(true);
    // Ticks keep firing while it hangs; none starts a second preflight.
    await settle(3 * 30_000);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);

    finishPreflight({ ok: true, problems: [], pgDumpVersion: '18.0', pgRestoreVersion: '18.0', serverVersion: '18.0' });
    await settle(0);
    expect(strapi.log.info.mock.calls.some(([line]: [string]) => line.includes('backup.runner_ready'))).toBe(true);
    await settle(6 * 60_000);
    expect(mocks.runBackupPreflight).toHaveBeenCalledTimes(1);
  });
});

describe('database backup runner stale-run reclaim', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initializeBackgroundContext();
    vi.stubEnv('BACKUP_RUNNER_ENABLED', 'true');
    vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', 'IN');
    for (const name of S3_ENV) vi.stubEnv(name, name === 'BACKUP_S3_REGION' ? 'ap-south-1' : 'value');
    vi.stubEnv('BACKUP_S3_BUCKET', 'current-bucket');
    mocks.runBackupPreflight.mockReset();
    mocks.runBackupPreflight.mockResolvedValue({
      ok: true, problems: [], pgDumpVersion: '18.0', pgRestoreVersion: '18.0', serverVersion: '18.0',
    });
    mocks.reclaimStaleRuns.mockReset();
    mocks.abortMultipartUploads.mockClear();
    mocks.deleteBackupObject.mockClear();
    mocks.headBackupObject.mockReset();
    mocks.headBackupObject.mockResolvedValue({ exists: false, sizeBytes: null, etag: null });
    mocks.readSidecarSha256.mockReset();
    mocks.readSidecarSha256.mockResolvedValue(null);
    mocks.reconcileRunSucceeded.mockClear();
  });

  afterEach(() => {
    resetDatabaseBackupRunnerForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  const events = (strapi: any, level: 'info' | 'warn', event: string) => strapi.log[level].mock.calls
    .map(([line]: [string]) => JSON.parse(line))
    .filter((entry: any) => entry.event === event);

  // Every archive carries its own run row as `running`; after a restore the
  // reclaim sees exactly a crashed run. The committed object must become a
  // success (in the bucket recorded on the row), never be deleted.
  it('reconciles a reclaimed run whose archive is committed instead of deleting it', async () => {
    mocks.reclaimStaleRuns
      .mockResolvedValueOnce([{ id: 'run-1', worker_id: 'w1', s3_bucket: 'previous-bucket', s3_key: 'k/IN/run-1.dump' }])
      .mockResolvedValue([]);
    mocks.headBackupObject.mockResolvedValueOnce({ exists: true, sizeBytes: 4096, etag: '"e1"' });
    mocks.readSidecarSha256.mockResolvedValueOnce('a'.repeat(64));
    const strapi = fakeStrapi();
    await startDatabaseBackupRunner(strapi);
    await settle(0);
    const client = mocks.createBackupS3Client.mock.results[0]!.value;
    expect(mocks.headBackupObject).toHaveBeenCalledWith(client, 'previous-bucket', 'k/IN/run-1.dump');
    expect(mocks.readSidecarSha256).toHaveBeenCalledWith(client, 'previous-bucket', 'k/IN/run-1.dump');
    expect(mocks.reconcileRunSucceeded).toHaveBeenCalledWith(strapi, 'run-1', {
      s3_bucket: 'previous-bucket', s3_key: 'k/IN/run-1.dump', size_bytes: 4096, sha256: 'a'.repeat(64), etag: '"e1"',
      verify_state: null,
    });
    expect(mocks.deleteBackupObject).not.toHaveBeenCalled();
    expect(mocks.abortMultipartUploads).not.toHaveBeenCalled();
    expect(events(strapi, 'info', 'backup.reclaimed_reconciled')).toEqual([
      expect.objectContaining({ runId: 'run-1', key: 'k/IN/run-1.dump', bytes: 4096, sidecar: true }),
    ]);
  });

  it('aborts only the open multipart when nothing was committed, in the current bucket for a legacy row', async () => {
    mocks.reclaimStaleRuns
      .mockResolvedValueOnce([
        { id: 'run-2', worker_id: 'w1', s3_bucket: null, s3_key: 'k/IN/run-2.dump' },
        { id: 'run-3', worker_id: 'w1', s3_bucket: null, s3_key: null },
      ])
      .mockResolvedValue([]);
    const strapi = fakeStrapi();
    await startDatabaseBackupRunner(strapi);
    await settle(0);
    const client = mocks.createBackupS3Client.mock.results[0]!.value;
    expect(mocks.headBackupObject.mock.calls).toEqual([[client, 'current-bucket', 'k/IN/run-2.dump']]);
    expect(mocks.abortMultipartUploads.mock.calls).toEqual([[client, 'current-bucket', 'k/IN/run-2.dump']]);
    expect(mocks.deleteBackupObject).not.toHaveBeenCalled();
    expect(mocks.reconcileRunSucceeded).not.toHaveBeenCalled();
    expect(events(strapi, 'warn', 'backup.stale_reclaimed').map((entry: any) => entry.runId)).toEqual(['run-2', 'run-3']);
  });

  it('reconciles without a checksum when the sidecar is missing and honours auto-verify', async () => {
    mocks.readBackupSettings.mockResolvedValueOnce({ scheduleEnabled: true, intervalHours: 6, deleteAfterDays: 7, autoVerify: true, alertEmail: null } as any);
    mocks.reclaimStaleRuns
      .mockResolvedValueOnce([{ id: 'run-4', worker_id: 'w1', s3_bucket: 'b', s3_key: 'k/IN/run-4.dump' }])
      .mockResolvedValue([]);
    mocks.headBackupObject.mockResolvedValueOnce({ exists: true, sizeBytes: 10, etag: null });
    const strapi = fakeStrapi();
    await startDatabaseBackupRunner(strapi);
    await settle(0);
    expect(mocks.reconcileRunSucceeded).toHaveBeenCalledWith(strapi, 'run-4', expect.objectContaining({
      sha256: null, size_bytes: 10, verify_state: 'pending',
    }));
    expect(events(strapi, 'info', 'backup.reclaimed_reconciled')[0]).toMatchObject({ sidecar: false });
    expect(mocks.deleteBackupObject).not.toHaveBeenCalled();
  });

  it('touches nothing in the bucket when the reclaim cannot inspect the object, and keeps ticking', async () => {
    mocks.reclaimStaleRuns
      .mockResolvedValueOnce([{ id: 'run-5', worker_id: 'w1', s3_bucket: 'b', s3_key: 'k/IN/run-5.dump' }])
      .mockResolvedValue([]);
    mocks.headBackupObject.mockRejectedValueOnce(new Error('AccessDenied'));
    const strapi = fakeStrapi();
    await startDatabaseBackupRunner(strapi);
    await settle(0);
    expect(events(strapi, 'warn', 'backup.reclaim_inspect_failed')).toEqual([
      expect.objectContaining({ runId: 'run-5', key: 'k/IN/run-5.dump', error: 'AccessDenied' }),
    ]);
    expect(mocks.abortMultipartUploads).not.toHaveBeenCalled();
    expect(mocks.deleteBackupObject).not.toHaveBeenCalled();
    expect(mocks.reconcileRunSucceeded).not.toHaveBeenCalled();
    expect(strapi.log.error.mock.calls.some(([line]: [string]) => line.includes('backup.tick_failed'))).toBe(false);
    await settle(30_000);
    expect(mocks.reclaimStaleRuns).toHaveBeenCalledTimes(2);
  });
});
