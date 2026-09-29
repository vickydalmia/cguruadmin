import { readWorkerHeartbeat, writeWorkerHeartbeat } from './outbox/worker-health';
import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueBlockedDependentsForAvailableTarget, TranslationOutboxStore } from './outbox/store';

const createIsr = require('../../database/migrations/2026.07.24T00.00.00.create-isr-outbox.js');
const hardenIsr = require('../../database/migrations/2026.07.25T00.00.00.harden-isr-outbox.js');
const receiptIsr = require('../../database/migrations/2026.07.29T12.00.00.add-isr-delivery-receipt.js');
const createTranslation = require('../../database/migrations/2026.08.30T00.00.00.create-translation-outbox.js');
const dependencyMigration = require('../../database/migrations/2026.09.04T00.00.00.translation-dependencies-and-isr-coalescing.js');
const reliabilityMigration = require('../../database/migrations/2026.09.05T00.00.00.translation-isr-reliability.js');
const performanceMigration = require('../../database/migrations/2026.09.06T00.00.00.translation-backfill-performance.js');

const platformMigration = require('../../database/migrations/2026.09.07T00.00.00.shared-platform-reliability.js');

const databaseUrl = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('translation/ISR reliability migrations on PostgreSQL', () => {
  let knex: Knex;
  const tables = [
    'translation_worker_heartbeats',
    'translation_backfill_runs',
    'translation_usage',
    'translation_state',
    'translation_outbox',
    'isr_outbox',
  ];

  beforeAll(() => {
    knex = knexFactory({
      client: 'pg',
      connection: databaseUrl,
      pool: { min: 0, max: 2 },
    });
  });

  beforeEach(async () => {
    for (const table of tables) await knex.schema.dropTableIfExists(table);
    await createIsr.up(knex);
    await hardenIsr.up(knex);
    await receiptIsr.up(knex);
    await createTranslation.up(knex);
    await dependencyMigration.up(knex);
    await reliabilityMigration.up(knex);
    await performanceMigration.up(knex);
    await platformMigration.up(knex);
  });

  afterAll(async () => {
    if (!knex) return;
    for (const table of tables) await knex.schema.dropTableIfExists(table);
    await knex.destroy();
  });

  it('keeps historical logical keys and enforces per-row delivery identity', async () => {
    const now = new Date();
    const insert = (status: string, deliveryKey: string) =>
      knex('isr_outbox').insert({
        event_key: 'translation-isr:ar',
        delivery_key: deliveryKey,
        payload: JSON.stringify({ localePrefix: '/ar', paths: ['/amazon/'] }),
        reason: 'translation',
        status,
        next_attempt_at: now,
        created_at: now,
        ...(status === 'delivered' ? { delivered_at: now } : {}),
      });

    await insert('delivered', '11111111-1111-4111-8111-111111111111');
    await insert('pending', '22222222-2222-4222-8222-222222222222');
    await expect(
      insert('pending', '33333333-3333-4333-8333-333333333333'),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insert('delivered', '44444444-4444-4444-8444-444444444444'),
    ).resolves.toBeDefined();
    await expect(
      knex('isr_outbox').insert({
        event_key: 'other',
        delivery_key: '11111111-1111-4111-8111-111111111111',
        payload: '{}',
        reason: 'duplicate delivery',
        status: 'delivered',
        next_attempt_at: now,
        created_at: now,
        delivered_at: now,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('installs dependency/latest indexes and one durable active-run guard', async () => {
    const rows = await knex('pg_indexes')
      .where({ schemaname: 'public' })
      .whereIn('indexname', [
        'translation_outbox_blocked_on_idx',
        'translation_outbox_event_latest_idx',
        'translation_outbox_document_locale_latest_idx',
        'translation_backfill_one_active_idx',
      ])
      .select('indexname');
    expect(new Set(rows.map((row) => row.indexname))).toEqual(
      new Set([
        'translation_outbox_blocked_on_idx',
        'translation_outbox_event_latest_idx',
        'translation_outbox_document_locale_latest_idx',
        'translation_backfill_one_active_idx',
      ]),
    );

    const run = (id: string) =>
      knex('translation_backfill_runs').insert({
        id,
        mode: 'repair',
        dry_run: false,
        force: false,
        request: '{}',
        status: 'running',
        progress: '{}',
        created_at: new Date(),
      });
    await run('11111111-1111-4111-8111-111111111111');
    await expect(
      run('22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('wakes the 20 category dependents once and resumes claims after a worker restart', async () => {
    const target = { uid: 'api::category.category', documentId: 'exclusive', targetLocale: 'ar' };
    const now = new Date();
    await knex('translation_outbox').insert(Array.from({ length: 20 }, (_, index) => ({
      event_key: `api::coupon.coupon:coupon-${index}:ar`, uid: 'api::coupon.coupon',
      document_id: `coupon-${index}`, target_locale: 'ar', kind: 'translate',
      force: false, status: 'blocked', attempt_count: 0, reason: 'test',
      created_at: now, next_attempt_at: now, blocked_on: JSON.stringify([{
        path: 'categories', required: true, targetUid: target.uid, documentId: target.documentId,
      }]),
    })));
    await knex.transaction(async (trx) => {
      expect(await enqueueBlockedDependentsForAvailableTarget(trx, target)).toBe(20);
    });
    expect(await enqueueBlockedDependentsForAvailableTarget(knex, target)).toBe(0);
    const createStore = () => new TranslationOutboxStore({ db: {
      connection: knex, transaction: (callback: any) => knex.transaction((trx) => callback({ trx })),
    } } as any, 120_000, 300_000);
    const first = await createStore().claim();
    expect(first?.kind).toBe('relation-sync');
    // Simulate a crashed worker's expired lease; a fresh store reclaims it.
    await knex('translation_outbox').where({ id: first!.id })
      .update({ locked_at: new Date(0) });
    const restarted = createStore();
    const reclaimed = await restarted.claim();
    expect(reclaimed?.id).toBe(first!.id);
    expect(reclaimed?.lockToken).not.toBe(first!.lockToken);
    await restarted.markDelivered(reclaimed!);
    for (let index = 1; index < 20; index += 1) {
      const job = await restarted.claim();
      expect(job).not.toBeNull();
      await restarted.markDelivered(job!);
    }
    expect(await restarted.claim()).toBeNull();
    expect(await enqueueBlockedDependentsForAvailableTarget(knex, target)).toBe(0);
    expect((await restarted.statusSummary()).counts).toEqual({ delivered: 20 });
  });
  it('keeps additive ledger fields across repeat migrations and old-style writes', async () => {
    await platformMigration.up(knex);
    await knex('translation_state').insert({ uid: 'api::store.store', document_id: 'old', locale: 'ar', source_hash: 'hash', translated_at: new Date() });
    const row = await knex('translation_state').first();
    expect(row.leaf_source_hashes).toBeNull();
    expect(await knex.schema.hasTable('translation_worker_heartbeats')).toBe(true);
  });

  it('serializes concurrent claims per document and reserves incremental capacity', async () => {
    const now = new Date();
    const entry = (key: string, reason: string) => ({ event_key: key, uid: 'api::store.store', document_id: key,
      target_locale: 'ar', kind: 'translate', status: 'pending', force: false, reason, created_at: now, next_attempt_at: now });
    await knex('translation_outbox').insert([entry('bulk', 'backfill'), entry('edit', 'editor save')]);
    const store = new TranslationOutboxStore({ db: { connection: knex,
      transaction: (callback: any) => knex.transaction((trx) => callback({ trx })),
    } } as any, 120_000, 300_000);
    const incremental = await store.claim({ incrementalOnly: true, locales: ['ar'] });
    expect(incremental?.documentId).toBe('edit');
    expect(await store.claim({ incrementalOnly: true, locales: ['ar'] })).toBeNull();
    await knex('translation_outbox').insert(entry('edit', 'editor save'));
    const claimed = await Promise.all([store.claim({ locales: ['ar'] }), store.claim({ locales: ['ar'] })]);
    expect(claimed.filter(Boolean).map((job) => job!.documentId)).toEqual(['bulk']);
    await store.markDelivered(incremental!);
    expect((await store.claim({ locales: ['ar'] }))?.documentId).toBe('edit');
  });

  it('reports durable worker liveness across separate processes and rejects stale heartbeats', async () => {
    await writeWorkerHeartbeat({ db: { connection: knex } } as any, 'maintenance', 'running');
    expect((await readWorkerHeartbeat({ db: { connection: knex } } as any)).healthy).toBe(true);
    await knex('translation_worker_heartbeats').update({ heartbeat_at: new Date(Date.now() - 61000) });
    expect((await readWorkerHeartbeat({ db: { connection: knex } } as any)).healthy).toBe(false);
  });

});
