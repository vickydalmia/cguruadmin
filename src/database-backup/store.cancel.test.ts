import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import knexFactory, { type Knex } from 'knex';

import { claimNextRun, findStaleRuns, handBackStaleRun, reconcileRunSucceeded, requestCancel } from './store';
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
  const goStale = async () => {
    const claim = await claimNextRun(strapi, 'worker-1');
    await knex('database_backup_runs').where({ id: 'run-1' }).update({
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', heartbeat_at: new Date(Date.now() - STALE_RUN_MS - 1000),
    });
    return claim!;
  };

  it('reconciles a stale run straight from running by its dead lease, and never twice', async () => {
    const claim = await goStale();
    const [staleRow] = await findStaleRuns(strapi, new Date());
    expect(staleRow?.id).toBe('run-1');
    expect(staleRow?.lock_token).toBe(claim.lockToken);

    // A wrong token (another lease) cannot reconcile it.
    expect(await reconcileRunSucceeded(strapi, 'run-1', 'someone-else', {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 1, sha256: null, etag: null, verify_state: null,
    })).toBe(false);
    expect(await reconcileRunSucceeded(strapi, 'run-1', claim.lockToken, {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 4096, sha256: 'f'.repeat(64), etag: '"e"', verify_state: 'pending',
    })).toBe(true);
    const after = await row();
    expect(after.status).toBe('succeeded');
    expect(after.size_bytes).toBe(4096);
    expect(after.sha256).toBe('f'.repeat(64));
    expect(after.verify_state).toBe('pending');
    expect(after.error).toBeNull();
    expect(after.lock_token).toBeNull();
    expect(after.s3_key).toBe('db/IN/run-1.dump');
    expect(await reconcileRunSucceeded(strapi, 'run-1', claim.lockToken, {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 1, sha256: null, etag: null, verify_state: null,
    })).toBe(false);
    expect(await findStaleRuns(strapi, new Date())).toEqual([]);
    expect(await claimNextRun(strapi, 'worker-2')).toBeNull();
  });

  // The failure mode being prevented: while the archive is unaccounted for,
  // the row must stay `running`, so nothing claims it and re-keys it.
  it('keeps an uninspected stale run unclaimable until it is handed back, then retries under a new key', async () => {
    const claim = await goStale();
    // Inspection failed: the reclaim touched nothing.
    expect(await claimNextRun(strapi, 'worker-2')).toBeNull();
    expect((await row()).s3_key).toBe('db/IN/run-1.dump');

    // Next tick: inspected, nothing committed, handed back for its retry.
    const [staleRow] = await findStaleRuns(strapi, new Date());
    expect(await handBackStaleRun(strapi, staleRow!, new Date())).toBe('pending');
    expect((await row()).status).toBe('pending');
    expect(await handBackStaleRun(strapi, staleRow!, new Date())).toBe('lost');
    // A hand-back cannot be reconciled any more (the retry owns the key now).
    expect(await reconcileRunSucceeded(strapi, 'run-1', claim.lockToken, {
      s3_bucket: 'b', s3_key: 'db/IN/run-1.dump', size_bytes: 1, sha256: null, etag: null, verify_state: null,
    })).toBe(false);
    const retry = await claimNextRun(strapi, 'worker-2');
    expect(retry?.id).toBe('run-1');
    expect(retry?.row.attempt_count).toBe(2);
  });

  it('fails a stale run that already used its retry and refuses to hand back a re-leased row', async () => {
    await goStale();
    await knex('database_backup_runs').where({ id: 'run-1' }).update({ attempt_count: 2 });
    const [staleRow] = await findStaleRuns(strapi, new Date());
    // The worker came back and heartbeated under a NEW lease before we acted.
    await knex('database_backup_runs').where({ id: 'run-1' }).update({ lock_token: 'renewed', heartbeat_at: new Date() });
    expect(await handBackStaleRun(strapi, staleRow!, new Date())).toBe('lost');
    expect((await row()).status).toBe('running');

    await knex('database_backup_runs').where({ id: 'run-1' }).update({ lock_token: staleRow!.lock_token });
    expect(await handBackStaleRun(strapi, staleRow!, new Date())).toBe('failed');
    const after = await row();
    expect(after.status).toBe('failed');
    expect(after.error).toBe('runner lost its lease');
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
