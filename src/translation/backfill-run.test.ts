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
  currentBackfillRun,
  resetBackfillRunForTests,
  startTranslationBackfill,
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

const waitFor = async (status: 'done' | 'failed') => {
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
      options.onProgress({
        uidsTotal: 7,
        uidsDone: 1,
        currentUid: 'api::brand.brand',
        documentsScanned: 549,
        selected: 120,
        enqueued: 120,
        skippedCurrent: 429,
        skippedIneligible: 0,
      });
      return result;
    });

    const { started, run } = await startTranslationBackfill(strapi, { mode: 'repair' });
    expect(started).toBe(true);
    expect(run).toMatchObject({ status: 'running', mode: 'repair', dryRun: false });
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
    finish(result);
    await waitFor('done');
  });

  it('persists failure and permits a later run', async () => {
    mocks.enqueueTranslationBackfill.mockRejectedValueOnce(new Error('out of shared memory'));
    await startTranslationBackfill(strapi, { mode: 'all' });
    expect(await waitFor('failed')).toMatchObject({ error: 'out of shared memory' });
    mocks.enqueueTranslationBackfill.mockResolvedValueOnce(result);
    expect((await startTranslationBackfill(strapi, { mode: 'all' })).started).toBe(true);
    await waitFor('done');
  });
});
