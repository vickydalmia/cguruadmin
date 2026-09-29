import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueRun: vi.fn(),
  requestCancel: vi.fn(),
  requestVerify: vi.fn(),
  markDeleted: vi.fn(),
  getRunRow: vi.fn(),
  listRuns: vi.fn(),
  getDatabaseBackupOverview: vi.fn(),
  writeBackupSettings: vi.fn(async (_strapi: unknown, value: unknown) => value),
  wakeDatabaseBackupRunner: vi.fn(),
}));

vi.mock('../../../database-backup/store', () => ({
  enqueueRun: mocks.enqueueRun,
  requestCancel: mocks.requestCancel,
  requestVerify: mocks.requestVerify,
  markDeleted: mocks.markDeleted,
}));
vi.mock('../../../database-backup/store-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../database-backup/store-rows')>()),
  getRunRow: mocks.getRunRow,
  listRuns: mocks.listRuns,
}));
vi.mock('../../../database-backup/status', () => ({ getDatabaseBackupOverview: mocks.getDatabaseBackupOverview }));
vi.mock('../../../database-backup/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../database-backup/settings')>()),
  writeBackupSettings: mocks.writeBackupSettings,
}));
vi.mock('../../../database-backup/runner', () => ({ wakeDatabaseBackupRunner: mocks.wakeDatabaseBackupRunner }));

import { BACKUP_SETTINGS_DEFAULTS } from '../../../constants/database-backup';
import controllerFactory, { parseNote, parseRunsQuery, requesterLabel } from './database-backup';

const strapi = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const controller = controllerFactory({ strapi });

function ctxFor(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return {
    state: { user: { id: 7, firstname: 'Jane', lastname: 'Doe', email: 'jane@example.com', roles: [{ code: 'strapi-super-admin' }] } },
    request: { body: {} },
    params: {},
    query: {},
    status: 200,
    body: undefined as unknown,
    set: (name: string, value: string) => { headers[name] = value; },
    headers,
    badRequest: vi.fn(function (this: any, message: string) { this.status = 400; this.body = { error: { message } }; }),
    notFound: vi.fn(function (this: any, message: string) { this.status = 404; this.body = { error: { message } }; }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseRunsQuery', () => {
  it('defaults, bounds and rejects', () => {
    expect(parseRunsQuery(undefined)).toEqual({ ok: true, page: 1, pageSize: 20 });
    expect(parseRunsQuery({ page: '3', pageSize: '50' })).toEqual({ ok: true, page: 3, pageSize: 50 });
    expect(parseRunsQuery({ page: '0' })).toEqual({ ok: false, message: 'page must be a positive integer' });
    expect(parseRunsQuery({ pageSize: '51' })).toEqual({ ok: false, message: 'pageSize must be an integer between 1 and 50' });
  });
});

describe('parseNote / requesterLabel', () => {
  it('trims, nulls blanks, and caps the note', () => {
    expect(parseNote(undefined)).toEqual({ ok: true, note: null });
    expect(parseNote('  before import ')).toEqual({ ok: true, note: 'before import' });
    expect(parseNote('   ')).toEqual({ ok: true, note: null });
    expect(parseNote(12)).toEqual({ ok: false, message: 'note must be a string' });
    expect(parseNote('x'.repeat(201))).toEqual({ ok: false, message: 'note must be at most 200 characters' });
  });

  it('labels the requester by name and email', () => {
    expect(requesterLabel({ firstname: 'Jane', lastname: 'Doe', email: 'jane@example.com' })).toBe('Jane Doe <jane@example.com>');
    expect(requesterLabel({ email: 'ops@example.com' })).toBe('ops@example.com');
    expect(requesterLabel({ id: 4 })).toBe('admin #4');
    expect(requesterLabel(null)).toBeNull();
  });
});

describe('createRun', () => {
  it('queues a manual run with the requester and wakes the runner', async () => {
    mocks.enqueueRun.mockResolvedValue({ created: true, row: { id: 'run-1', trigger: 'manual', status: 'pending', created_at: new Date() } });
    const ctx = ctxFor({ request: { body: { note: ' nightly check ' } } });
    await controller.createRun(ctx);
    expect(mocks.enqueueRun).toHaveBeenCalledWith(strapi, {
      trigger: 'manual', requestedById: 7, requestedByLabel: 'Jane Doe <jane@example.com>', note: 'nightly check',
    });
    expect(ctx.status).toBe(202);
    expect((ctx.body as any).run.id).toBe('run-1');
    expect(ctx.headers['Cache-Control']).toBe('private, no-store');
    expect(mocks.wakeDatabaseBackupRunner).toHaveBeenCalledTimes(1);
  });

  it('answers 409 with the active run when one is already in flight', async () => {
    mocks.enqueueRun.mockResolvedValue({ created: false, row: { id: 'active', trigger: 'scheduled', status: 'running', created_at: new Date() } });
    const ctx = ctxFor();
    await controller.createRun(ctx);
    expect(ctx.status).toBe(409);
    expect((ctx.body as any).run.id).toBe('active');
    expect(mocks.wakeDatabaseBackupRunner).not.toHaveBeenCalled();
  });

  it('rejects an over-long note before touching the store', async () => {
    const ctx = ctxFor({ request: { body: { note: 'x'.repeat(201) } } });
    await controller.createRun(ctx);
    expect(ctx.status).toBe(400);
    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });
});

describe('updateSettings', () => {
  it('validates and persists the full settings object', async () => {
    const ctx = ctxFor({ request: { body: { data: { ...BACKUP_SETTINGS_DEFAULTS, intervalHours: 12 } } } });
    await controller.updateSettings(ctx);
    expect(mocks.writeBackupSettings).toHaveBeenCalledWith(strapi, { ...BACKUP_SETTINGS_DEFAULTS, intervalHours: 12 });
    expect(ctx.body).toEqual({ ...BACKUP_SETTINGS_DEFAULTS, intervalHours: 12 });
    expect(mocks.wakeDatabaseBackupRunner).toHaveBeenCalledTimes(1);
  });

  it('returns the problem list on invalid input', async () => {
    const ctx = ctxFor({ request: { body: { ...BACKUP_SETTINGS_DEFAULTS, intervalHours: 5 } } });
    await controller.updateSettings(ctx);
    expect(ctx.status).toBe(400);
    expect((ctx.body as any).error.details.problems.join(' ')).toContain('intervalHours');
    expect(mocks.writeBackupSettings).not.toHaveBeenCalled();
  });
});

describe('run actions', () => {
  it('guards ids and reports non-active cancels as 409', async () => {
    const bad = ctxFor({ params: { id: 'nope' } });
    await controller.cancelRun(bad);
    expect(bad.status).toBe(400);

    mocks.requestCancel.mockResolvedValue('not-active');
    const done = ctxFor({ params: { id: '3f2a9c1e-1111-2222-3333-444444444444' } });
    await controller.cancelRun(done);
    expect(done.status).toBe(409);

    mocks.requestCancel.mockResolvedValue('requested');
    mocks.getRunRow.mockResolvedValue({ id: '3f2a9c1e-1111-2222-3333-444444444444', status: 'running', trigger: 'manual', created_at: new Date() });
    const ok = ctxFor({ params: { id: '3f2a9c1e-1111-2222-3333-444444444444' } });
    await controller.cancelRun(ok);
    expect((ok.body as any).state).toBe('requested');
    expect(mocks.wakeDatabaseBackupRunner).toHaveBeenCalled();
  });

  it('only verifies stored runs', async () => {
    mocks.requestVerify.mockResolvedValue(false);
    const ctx = ctxFor({ params: { id: '3f2a9c1e-1111-2222-3333-444444444444' } });
    await controller.verifyRun(ctx);
    expect(ctx.status).toBe(409);
  });

  it('404s a download for a run without an archive', async () => {
    mocks.getRunRow.mockResolvedValue({ id: 'x', status: 'failed', s3_key: null });
    const ctx = ctxFor({ params: { id: '3f2a9c1e-1111-2222-3333-444444444444' } });
    await controller.downloadUrl(ctx);
    expect(ctx.status).toBe(404);
  });
});
