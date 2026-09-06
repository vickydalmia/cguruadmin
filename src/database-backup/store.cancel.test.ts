import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import knexFactory, { type Knex } from 'knex';

import { claimNextRun, reclaimStaleRuns, reconcileRunSucceeded, requestCancel } from './store';
import { STALE_RUN_MS } from './constants';

const createRuns = require('../../database/migrations/2026.09.10T00.00.00.create-database-backup-runs.js');
const verifyLease = require('../../database/migrations/2026.09.11T00.00.00.database-backup-verify-lease.js');

describe('requestCancel', () => {
  let knex: Knex;
  let strapi: any;

  beforeEach(async () => {
    knex = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await createRuns.up(knex);
    await verifyLease.up(knex);
    strapi = { db: { connection: knex, transaction: (fn: any) => knex.transaction((trx) => fn({ trx })) } };
    await knex('database_backup_runs').insert({ id: 'run-1', trigger: 'manual', status: 'pending', created_at: new Date() });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  const row = () => knex('database_backup_runs').where({ id: 'run-1' }).first();

  it('cancels a pending run outright and flags a running one', async () => {
    expect(await requestCancel(strapi, 'missing')).toBe('not-active');
    expect(await requestCancel(strapi, 'run-1')).toBe('cancelled');
    expect((await row()).status).toBe('cancelled');
    expect(await requestCancel(strapi, 'run-1')).toBe('not-active');

    await knex('database_backup_runs').where({ id: 'run-1' }).update({ status: 'pending', finished_at: null });
    const claim = await claimNextRun(strapi, 'worker-1');
    expect(claim?.id).toBe('run-1');
    expect(await requestCancel(strapi, 'run-1')).toBe('requested');
    const running = await row();
    expect(running.status).toBe('running');
    expect(running.cancel_requested_at).not.toBeNull();
  });

  // The race the lock and the update counts exist for: the runner claims the
  // row after the cancel read it as pending. The pending→cancelled write then
  // matches nothing, and the answer must become the running-state flag.
  it('turns into the running flag when the runner claims the row under it', async () => {
    const real = strapi.db.transaction;
    strapi.db.transaction = (fn: any) => real(async ({ trx }: any) => {
      const claimed = { value: false };
      const proxied = new Proxy(trx, {
        apply(target, thisArg, args) {
          const builder = Reflect.apply(target, thisArg, args);
          const originalFirst = builder.first.bind(builder);
          builder.first = async (...rest: any[]) => {
            const result = await originalFirst(...rest);
            if (!claimed.value) {
              claimed.value = true;
              // The runner's claim lands between the read and the write. (SQLite
              // has one connection here, so the interleaved write goes through
              // the same handle; the row state is what matters.)
              await Reflect.apply(target, thisArg, ['database_backup_runs'])
                .where({ id: 'run-1', status: 'pending' })
                .update({ status: 'running', lock_token: 'other', heartbeat_at: new Date() });
            }
            return result;
          };
          return builder;
        },
      });
      return fn({ trx: proxied });
    });
    expect(await requestCancel(strapi, 'run-1')).toBe('requested');
    const after = await row();
    expect(after.status).toBe('running');
    expect(after.cancel_requested_at).not.toBeNull();
  });

  // The row a restore brings back: `running` under a dead lease, key set.
  it('reconciles a reclaimed run into a success only while it has no lease', async () => {
    const claim = await claimNextRun(strapi, 'worker-1');
    await knex('database_backup_runs').where({ id: 'run-1' }).update({
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', heartbeat_at: new Date(Date.now() - STALE_RUN_MS - 1000),
    });
    // Still leased (from the row's point of view): not eligible.
    expect(await reconcileRunSucceeded(strapi, 'run-1', {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 1, sha256: null, etag: null, verify_state: null,
    })).toBe(false);
    expect(claim?.lockToken).toBeTruthy();

    const reclaimed = await reclaimStaleRuns(strapi, new Date());
    expect(reclaimed.map((r) => r.id)).toEqual(['run-1']);
    expect((await row()).status).toBe('pending');

    expect(await reconcileRunSucceeded(strapi, 'run-1', {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 4096, sha256: 'f'.repeat(64), etag: '"e"', verify_state: 'pending',
    })).toBe(true);
    const after = await row();
    expect(after.status).toBe('succeeded');
    expect(after.size_bytes).toBe(4096);
    expect(after.sha256).toBe('f'.repeat(64));
    expect(after.verify_state).toBe('pending');
    expect(after.error).toBeNull();
    expect(after.lock_token).toBeNull();
    // A success is never reconciled twice, and it is not claimable.
    expect(await reconcileRunSucceeded(strapi, 'run-1', {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 1, sha256: null, etag: null, verify_state: null,
    })).toBe(false);
    expect(await claimNextRun(strapi, 'worker-2')).toBeNull();
  });

  it('locks the row for the decision on Postgres', async () => {
    const forUpdate = vi.fn();
    const builder: any = {
      where: vi.fn(() => builder),
      forUpdate: vi.fn(() => { forUpdate(); return builder; }),
      first: vi.fn(async () => ({ id: 'run-1', status: 'pending' })),
      update: vi.fn(async () => 1),
    };
    const trx: any = Object.assign(vi.fn(() => builder), { client: { config: { client: 'postgres' } } });
    const fake = { db: { transaction: (fn: any) => fn({ trx }) } } as any;
    expect(await requestCancel(fake, 'run-1')).toBe('cancelled');
    expect(forUpdate).toHaveBeenCalledTimes(1);
  });
});
