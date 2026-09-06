import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knexFactory, { type Knex } from 'knex';
import {
  enqueueBlockedDependentsForAvailableTarget,
  TranslationOutboxStore,
} from './outbox/store';
import { IsrOutboxStore } from '../isr-outbox/store';

const createIsr = require('../../database/migrations/2026.07.24T00.00.00.create-isr-outbox.js');
const hardenIsr = require('../../database/migrations/2026.07.25T00.00.00.harden-isr-outbox.js');
const receiptIsr = require('../../database/migrations/2026.07.29T12.00.00.add-isr-delivery-receipt.js');
const createTranslation = require('../../database/migrations/2026.08.30T00.00.00.create-translation-outbox.js');
const dependencyMigration = require('../../database/migrations/2026.09.04T00.00.00.translation-dependencies-and-isr-coalescing.js');
const reliabilityMigration = require('../../database/migrations/2026.09.05T00.00.00.translation-isr-reliability.js');
const performanceMigration = require('../../database/migrations/2026.09.06T00.00.00.translation-backfill-performance.js');

describe('translation/ISR reliability migrations on SQLite', () => {
  let knex: Knex;

  beforeEach(async () => {
    knex = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await createIsr.up(knex);
    await hardenIsr.up(knex);
    await receiptIsr.up(knex);
    await createTranslation.up(knex);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('preserves history, installs pending-only coalescing, and is rerunnable', async () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    await knex('isr_outbox').insert([
      {
        event_key: 'translation-isr:ar',
        payload: JSON.stringify({ localePrefix: '/ar', paths: ['/old/'] }),
        reason: 'old translation',
        status: 'delivered',
        next_attempt_at: now,
        created_at: now,
        delivered_at: now,
      },
      {
        event_key: 'translation-isr:ar',
        payload: JSON.stringify({ localePrefix: '/ar', paths: ['/new/'] }),
        reason: 'new translation',
        status: 'pending',
        next_attempt_at: now,
        created_at: now,
      },
    ]);

    await dependencyMigration.up(knex);
    await reliabilityMigration.up(knex);
    await performanceMigration.up(knex);
    await performanceMigration.up(knex);
    await reliabilityMigration.up(knex);

    const rows = await knex('isr_outbox').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(2);
    expect(rows.every((row) => typeof row.delivery_key === 'string')).toBe(true);

    await expect(
      knex('isr_outbox').insert({
        event_key: 'translation-isr:ar',
        delivery_key: '11111111-1111-4111-8111-111111111111',
        payload: '{}',
        reason: 'duplicate pending',
        status: 'pending',
        next_attempt_at: now,
        created_at: now,
      }),
    ).rejects.toThrow(/unique/i);

    await expect(
      knex('isr_outbox').insert({
        event_key: 'translation-isr:ar',
        delivery_key: '22222222-2222-4222-8222-222222222222',
        payload: '{}',
        reason: 'new history',
        status: 'delivered',
        next_attempt_at: now,
        created_at: now,
        delivered_at: now,
      }),
    ).resolves.toBeDefined();

    await expect(knex.schema.hasColumn('translation_outbox', 'blocked_on')).resolves.toBe(true);
    await expect(knex.schema.hasColumn('translation_outbox', 'source_hash')).resolves.toBe(true);
    await expect(knex.schema.hasColumn('translation_outbox', 'outcome_code')).resolves.toBe(true);
    await expect(knex.schema.hasTable('translation_backfill_runs')).resolves.toBe(true);
    await expect(knex.schema.hasColumn('translation_backfill_runs', 'checkpoint')).resolves.toBe(true);
    await expect(knex.schema.hasColumn('translation_state', 'published_plan_hash')).resolves.toBe(true);
  });

  it('claims jobs and wakes a blocked parent exactly once on SQLite', async () => {
    await dependencyMigration.up(knex);
    await reliabilityMigration.up(knex);
    await performanceMigration.up(knex);
    const old = new Date('2020-01-01T00:00:00.000Z');
    const dependency = {
      path: 'coupons.0',
      targetUid: 'api::coupon.coupon',
      documentId: 'coupon-child',
      required: false,
    };
    const parentKey = 'api::store.store:store-parent:ar';
    const supersededKey = 'api::store.store:old-parent:ar';
    const base = {
      target_locale: 'ar',
      kind: 'translate',
      attempt_count: 0,
      next_attempt_at: old,
      reason: 'test',
      created_at: old,
    };
    await knex('translation_outbox').insert([
      {
        ...base,
        event_key: parentKey,
        uid: 'api::store.store',
        document_id: 'store-parent',
        force: true,
        status: 'blocked',
        blocked_on: JSON.stringify([dependency]),
      },
      {
        ...base,
        event_key: supersededKey,
        uid: 'api::store.store',
        document_id: 'old-parent',
        force: false,
        status: 'blocked',
        blocked_on: JSON.stringify([dependency]),
      },
      {
        ...base,
        event_key: supersededKey,
        uid: 'api::store.store',
        document_id: 'old-parent',
        force: false,
        status: 'delivered',
      },
    ]);

    await expect(
      enqueueBlockedDependentsForAvailableTarget(knex, {
        uid: dependency.targetUid,
        documentId: dependency.documentId,
        targetLocale: 'ar',
      }),
    ).resolves.toBe(1);
    await expect(
      enqueueBlockedDependentsForAvailableTarget(knex, {
        uid: dependency.targetUid,
        documentId: dependency.documentId,
        targetLocale: 'ar',
      }),
    ).resolves.toBe(0);

    const pendingParent = await knex('translation_outbox')
      .where({ event_key: parentKey, status: 'pending' })
      .first();
    expect(pendingParent).toMatchObject({
      kind: 'relation-sync',
      force: 1,
    });
    await expect(
      knex('translation_outbox')
        .where({ event_key: supersededKey, status: 'pending' })
        .first(),
    ).resolves.toBeUndefined();

    const transaction = (callback: any) =>
      knex.transaction((trx) => callback({ trx }));
    const translationStore = new TranslationOutboxStore(
      { db: { connection: knex, transaction } } as any,
      120_000,
      300_000,
    );
    await expect(translationStore.claim()).resolves.toMatchObject({
      eventKey: parentKey,
      force: true,
    });

    await knex('isr_outbox').insert({
      event_key: 'sqlite-claim',
      delivery_key: '33333333-3333-4333-8333-333333333333',
      payload: JSON.stringify({ all: true }),
      reason: 'sqlite claim',
      status: 'pending',
      next_attempt_at: old,
      created_at: old,
    });
    const isrStore = new IsrOutboxStore(
      { db: { connection: knex, transaction } } as any,
      120_000,
      300_000,
    );
    await expect(isrStore.claim()).resolves.toMatchObject({
      state: 'event',
      event: { eventKey: 'sqlite-claim' },
    });
  });

  it('reports only the latest job per document while retaining failure history', async () => {
    await dependencyMigration.up(knex);
    await reliabilityMigration.up(knex);
    await performanceMigration.up(knex);
    const now = new Date();
    const base = {
      uid: 'api::coupon.coupon',
      target_locale: 'ar',
      kind: 'translate',
      force: false,
      attempt_count: 0,
      next_attempt_at: now,
      reason: 'test',
      created_at: now,
    };
    await knex('translation_outbox').insert([
      {
        ...base,
        event_key: 'api::coupon.coupon:repaired:ar',
        document_id: 'repaired',
        status: 'failed',
        outcome_code: 'failed',
        last_error: 'old failure',
      },
      {
        ...base,
        event_key: 'api::coupon.coupon:repaired:ar',
        document_id: 'repaired',
        status: 'delivered',
        outcome_code: 'delivered',
        delivered_at: now,
      },
      {
        ...base,
        event_key: 'api::coupon.coupon:waiting:ar',
        document_id: 'waiting',
        status: 'blocked',
        outcome_code: 'blocked',
        blocked_on: '[]',
      },
    ]);
    const store = new TranslationOutboxStore(
      { db: { connection: knex } } as any,
      120_000,
      300_000,
    );

    const summary = await store.statusSummary();
    expect(summary.counts).toEqual({ delivered: 1, blocked: 1 });
    expect(summary.historicalFailures).toBe(1);
    expect(summary.deliveredToday).toBe(1);
  });

  it('loads page-sized state and latest-job snapshots in two batched reads', async () => {
    await dependencyMigration.up(knex);
    await reliabilityMigration.up(knex);
    await performanceMigration.up(knex);
    const now = new Date();
    await knex('translation_state').insert([
      {
        uid: 'api::store.store',
        document_id: 'store-a',
        locale: 'ar',
        source_hash: 'source-a',
        published_plan_hash: 'plan-a',
        translated_at: now,
        needs_review: false,
        translations: JSON.stringify({ name: 'متجر' }),
      },
      {
        uid: 'api::store.store',
        document_id: 'outside-page',
        locale: 'ar',
        source_hash: 'outside',
        translated_at: now,
        needs_review: false,
      },
    ]);
    const base = {
      event_key: 'api::store.store:store-a:ar',
      uid: 'api::store.store',
      document_id: 'store-a',
      target_locale: 'ar',
      kind: 'translate',
      force: false,
      next_attempt_at: now,
      reason: 'test',
      created_at: now,
    };
    await knex('translation_outbox').insert([
      {
        ...base,
        status: 'failed',
        attempt_count: 1,
        source_hash: 'old-source',
        outcome_code: 'failed',
        last_error: 'old failure',
      },
      {
        ...base,
        status: 'delivered',
        attempt_count: 0,
        source_hash: 'source-a',
        outcome_code: 'delivered',
        delivered_at: now,
      },
      {
        ...base,
        status: 'failed',
        attempt_count: 0,
        source_hash: 'source-a',
        outcome_code: 'unchanged-terminal-failure',
        last_error: 'irrelevant validation history',
      },
    ]);
    const store = new TranslationOutboxStore(
      { db: { connection: knex } } as any,
      120_000,
      300_000,
    );

    const snapshot = await store.readBackfillSnapshot(
      'api::store.store',
      ['store-a'],
      ['ar'],
    );

    expect(snapshot.states.get('store-a\u0000ar')).toMatchObject({
      sourceHash: 'source-a',
      publishedPlanHash: 'plan-a',
      translations: { name: 'متجر' },
    });
    expect(snapshot.jobs.get('store-a\u0000ar')).toMatchObject({
      status: 'delivered',
      sourceHash: 'source-a',
    });
    expect(snapshot.states.has('outside-page\u0000ar')).toBe(false);
  });
});
