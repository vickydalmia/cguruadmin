import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knexFactory, { type Knex } from 'knex';

import { STALE_RUN_MS } from './constants';
import {
  claimVerify,
  finishVerify,
  heartbeatVerify,
  reclaimStaleVerifications,
  requestVerify,
  VERIFY_LEASE_LOST_ERROR,
} from './store';

const createRuns = require('../../database/migrations/2026.09.10T00.00.00.create-database-backup-runs.js');
const verifyLease = require('../../database/migrations/2026.09.11T00.00.00.database-backup-verify-lease.js');

// The store talks knex, so a throwaway SQLite database proves the lease
// protocol end to end: claim → heartbeat → stale reclaim → re-request.
describe('verification lease', () => {
  let knex: Knex;
  let strapi: any;

  beforeEach(async () => {
    knex = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await createRuns.up(knex);
    await verifyLease.up(knex);
    await verifyLease.up(knex); // rerunnable
    strapi = { db: { connection: knex, transaction: (fn: any) => knex.transaction((trx) => fn({ trx })) } };
    await knex('database_backup_runs').insert({
      id: 'run-1', trigger: 'manual', status: 'succeeded', s3_bucket: 'b', s3_key: 'k',
      verify_state: 'pending', verify_requested_at: new Date('2026-09-06T10:00:00Z'),
    });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  const row = () => knex('database_backup_runs').where({ id: 'run-1' }).first();

  it('claims with a heartbeat, keeps a live verification, and finishes cleanly', async () => {
    const claimed = await claimVerify(strapi);
    expect(claimed?.id).toBe('run-1');
    expect((await row()).verify_heartbeat_at).not.toBeNull();
    expect(await claimVerify(strapi)).toBeNull();

    expect(await heartbeatVerify(strapi, 'run-1')).toBe(true);
    expect(await reclaimStaleVerifications(strapi, new Date())).toEqual([]);

    await finishVerify(strapi, 'run-1', { ok: true, tocEntries: 7 });
    const finished = await row();
    expect(finished.verify_state).toBe('ok');
    expect(finished.verify_toc_entries).toBe(7);
    expect(finished.verify_heartbeat_at).toBeNull();
    expect(await heartbeatVerify(strapi, 'run-1')).toBe(false);
  });

  it('fails a verification whose worker stopped heartbeating so it can be requested again', async () => {
    await claimVerify(strapi);
    const later = new Date(Date.now() + STALE_RUN_MS + 1000);
    const reclaimed = await reclaimStaleVerifications(strapi, later);
    expect(reclaimed.map((r) => r.id)).toEqual(['run-1']);
    const failed = await row();
    expect(failed.verify_state).toBe('failed');
    expect(failed.verify_error).toBe(VERIFY_LEASE_LOST_ERROR);
    expect(failed.status).toBe('succeeded');
    // The worker that lost the lease cannot write over the new state.
    expect(await heartbeatVerify(strapi, 'run-1')).toBe(false);
    await finishVerify(strapi, 'run-1', { ok: true, tocEntries: 1 });
    expect((await row()).verify_state).toBe('failed');
    // A Super Admin can ask again.
    expect(await requestVerify(strapi, 'run-1')).toBe(true);
    expect((await claimVerify(strapi))?.id).toBe('run-1');
  });

  it('also frees rows that were stuck in running before the lease existed', async () => {
    await knex('database_backup_runs').where({ id: 'run-1' }).update({ verify_state: 'running', verify_heartbeat_at: null });
    const reclaimed = await reclaimStaleVerifications(strapi, new Date());
    expect(reclaimed).toHaveLength(1);
    expect((await row()).verify_state).toBe('failed');
  });
});
