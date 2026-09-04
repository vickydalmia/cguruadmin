import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const createIsr = require('../../database/migrations/2026.07.24T00.00.00.create-isr-outbox.js');
const hardenIsr = require('../../database/migrations/2026.07.25T00.00.00.harden-isr-outbox.js');
const receiptIsr = require('../../database/migrations/2026.07.29T12.00.00.add-isr-delivery-receipt.js');
const createTranslation = require('../../database/migrations/2026.08.30T00.00.00.create-translation-outbox.js');
const dependencyMigration = require('../../database/migrations/2026.09.04T00.00.00.translation-dependencies-and-isr-coalescing.js');
const reliabilityMigration = require('../../database/migrations/2026.09.05T00.00.00.translation-isr-reliability.js');
const performanceMigration = require('../../database/migrations/2026.09.06T00.00.00.translation-backfill-performance.js');

const databaseUrl = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('translation/ISR reliability migrations on PostgreSQL', () => {
  let knex: Knex;
  const tables = [
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
});
