import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import knexFactory, { type Knex } from 'knex';

const mocks = vi.hoisted(() => ({
  enqueueTranslationBackfill: vi.fn(),
  estimateTranslationBackfill: vi.fn(),
}));

vi.mock('./backfill', () => ({
  enqueueTranslationBackfill: mocks.enqueueTranslationBackfill,
  estimateTranslationBackfill: mocks.estimateTranslationBackfill,
}));

import {
  backfillRunActive,
  cancelTranslationBackfill,
  currentBackfillRun,
  resetBackfillRunForTests,
  resumeTranslationBackfillRun,
  startTranslationBackfill,
  translationBackfillRunnerEnabled,
} from './backfill-run';

let knex: Knex;
let strapi: any;

const result = {
  selected: 3,
  enqueued: 3,
  skippedCurrent: 1,
  skippedIneligible: 0,
  providerCallsExpected: 2,
  perUid: { 'api::store.store': 3 },
  locales: ['ar'],
};

const waitFor = async (status: 'done' | 'failed' | 'cancelled') => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await currentBackfillRun(strapi);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`run did not become ${status}`);
};

beforeEach(async () => {
  knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await knex.schema.createTable('translation_backfill_runs', (table) => {
    table.uuid('id').primary();
    table.string('mode').notNullable();
    table.boolean('dry_run').notNullable();
    table.boolean('force').notNullable();
    table.json('request').notNullable();
    table.string('status').notNullable();
    table.json('progress').notNullable();
    table.json('checkpoint').nullable();
    table.json('result').nullable();
    table.text('last_error').nullable();
    table.timestamp('locked_at').nullable();
    table.string('lock_token').nullable();
    table.timestamp('created_at').notNullable();
    table.timestamp('finished_at').nullable();
  });
  strapi = {
    db: {
      connection: knex,
      transaction: (callback: any) => knex.transaction((trx) => callback({ trx })),
    },
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

afterEach(async () => {
  resetBackfillRunForTests();
  vi.clearAllMocks();
  await knex.destroy();
});

describe('startTranslationBackfill', () => {
  it('persists progress and completes outside the HTTP request', async () => {
    mocks.enqueueTranslationBackfill.mockImplementationOnce(async (_strapi, options) => {
      await options.onCheckpoint({
        uidsTotal: 7,
        uidsDone: 1,
        currentUid: 'api::brand.brand',
        documentsScanned: 549,
        selected: 120,
        enqueued: 120,
        skippedCurrent: 429,
        skippedIneligible: 0,
      }, {
        uidIndex: 1,
        lastSourceId: 549,
        documentsScanned: 549,
        scan: {
          selected: 120,
          enqueued: 120,
          skippedCurrent: 429,
          skippedIneligible: 0,
          providerChars: [],
          perUid: { 'api::brand.brand': 120 },
        },
      });
      return result;
    });

    const { started, run } = await startTranslationBackfill(strapi, { mode: 'repair' });
    expect(started).toBe(true);
    expect(run).toMatchObject({ status: 'pending', mode: 'repair', dryRun: false });
    await resumeTranslationBackfillRun(strapi);
    expect(await waitFor('done')).toMatchObject({
      result,
      progress: { documentsScanned: 549 },
    });
    expect(await backfillRunActive(strapi)).toBe(false);
  });

  it('returns the durable active run instead of starting another', async () => {
    let finish!: (value: typeof result) => void;
    mocks.estimateTranslationBackfill.mockReturnValueOnce(
      new Promise((resolve) => { finish = resolve; }),
    );
    const first = await startTranslationBackfill(strapi, { dryRun: true, mode: 'repair' });
    const second = await startTranslationBackfill(strapi, { mode: 'all' });
    expect(second.started).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(mocks.enqueueTranslationBackfill).not.toHaveBeenCalled();
    await resumeTranslationBackfillRun(strapi);
    finish(result);
    await waitFor('done');
  });

  it('persists failure and permits a later run', async () => {
    mocks.enqueueTranslationBackfill.mockRejectedValueOnce(new Error('out of shared memory'));
    await startTranslationBackfill(strapi, { mode: 'all' });
    await resumeTranslationBackfillRun(strapi);
    expect(await waitFor('failed')).toMatchObject({ error: 'out of shared memory' });
    mocks.enqueueTranslationBackfill.mockResolvedValueOnce(result);
    expect((await startTranslationBackfill(strapi, { mode: 'all' })).started).toBe(true);
    await resumeTranslationBackfillRun(strapi);
    await waitFor('done');
  });

  it('cancels a pending run without deleting already-enqueued work', async () => {
    const started = await startTranslationBackfill(strapi, { mode: 'repair' });
    const stopped = await cancelTranslationBackfill(strapi, started.run.id);
    expect(stopped).toMatchObject({ cancelled: true, run: { status: 'cancelled' } });
    expect(await backfillRunActive(strapi)).toBe(false);
    expect(mocks.enqueueTranslationBackfill).not.toHaveBeenCalled();
  });

  it('resumes a stale run from its durable page checkpoint', async () => {
    const checkpoint = {
      uidIndex: 2,
      lastSourceId: 150,
      documentsScanned: 850,
      scan: {
        selected: 140,
        enqueued: 140,
        skippedCurrent: 710,
        skippedIneligible: 0,
        providerChars: [20, 30],
        perUid: { 'api::store.store': 140 },
      },
    };
    await knex('translation_backfill_runs').insert({
      id: 'stale-run',
      mode: 'repair',
      dry_run: false,
      force: false,
      request: JSON.stringify({ mode: 'repair', locales: ['ar'] }),
      status: 'running',
      progress: JSON.stringify({ ...emptyProgressForTest(), documentsScanned: 850 }),
      checkpoint: JSON.stringify(checkpoint),
      result: null,
      last_error: null,
      locked_at: new Date(Date.now() - 10 * 60_000),
      lock_token: 'dead-process',
      created_at: new Date(Date.now() - 20 * 60_000),
      finished_at: null,
    });
    mocks.enqueueTranslationBackfill.mockResolvedValueOnce(result);

    expect(await resumeTranslationBackfillRun(strapi)).toBe(true);
    await waitFor('done');
    expect(mocks.enqueueTranslationBackfill).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({ checkpoint }),
    );
  });

  it('stops a running scan at the next checkpoint after cancellation', async () => {
    let continueScan!: () => void;
    let reachedFirstPage!: () => void;
    const firstPage = new Promise<void>((resolve) => { reachedFirstPage = resolve; });
    const continueAfterCancel = new Promise<void>((resolve) => { continueScan = resolve; });
    mocks.enqueueTranslationBackfill.mockImplementationOnce(async (_strapi, options) => {
      reachedFirstPage();
      await continueAfterCancel;
      await options.onCheckpoint(emptyProgressForTest(), {
        uidIndex: 0,
        lastSourceId: 50,
        documentsScanned: 50,
        scan: {
          selected: 0,
          enqueued: 0,
          skippedCurrent: 50,
          skippedIneligible: 0,
          providerChars: [],
          perUid: {},
        },
      });
      return result;
    });

    const started = await startTranslationBackfill(strapi, { mode: 'repair' });
    await resumeTranslationBackfillRun(strapi);
    await firstPage;
    expect(await cancelTranslationBackfill(strapi, started.run.id)).toMatchObject({
      cancelled: true,
      run: { status: 'cancelled' },
    });
    continueScan();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await currentBackfillRun(strapi)).toMatchObject({ status: 'cancelled' });
    expect(strapi.log.info).toHaveBeenCalledWith(
      expect.stringContaining('stopped after cancellation or lease loss'),
    );
  });
});

function emptyProgressForTest() {
  return {
    uidsTotal: 0,
    uidsDone: 0,
    currentUid: null,
    documentsScanned: 0,
    selected: 0,
    enqueued: 0,
    skippedCurrent: 0,
    skippedIneligible: 0,
  };
}

describe('translationBackfillRunnerEnabled', () => {
  it('allows production to dedicate scan ownership to one process', () => {
    const previous = {
      runner: process.env.TRANSLATION_BACKFILL_RUNNER_ENABLED,
      dispatcher: process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED,
      cron: process.env.CRON_ENABLED,
    };
    try {
      process.env.TRANSLATION_BACKFILL_RUNNER_ENABLED = 'false';
      process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED = 'true';
      process.env.CRON_ENABLED = 'true';
      expect(translationBackfillRunnerEnabled()).toBe(false);

      process.env.TRANSLATION_BACKFILL_RUNNER_ENABLED = 'true';
      process.env.TRANSLATION_OUTBOX_DISPATCHER_ENABLED = 'false';
      process.env.CRON_ENABLED = 'false';
      expect(translationBackfillRunnerEnabled()).toBe(true);
    } finally {
      setOrDeleteEnv('TRANSLATION_BACKFILL_RUNNER_ENABLED', previous.runner);
      setOrDeleteEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', previous.dispatcher);
      setOrDeleteEnv('CRON_ENABLED', previous.cron);
    }
  });
});

function setOrDeleteEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
