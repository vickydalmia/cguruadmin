import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = require('../../database/migrations/2026.07.31T03.00.00.reconcile-legacy-isr-outbox-optional-paths.js');

const databaseUrl = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('legacy ISR payload migration on PostgreSQL', () => {
  let knex: Knex;

  beforeAll(() => {
    knex = knexFactory({
      client: 'pg',
      connection: databaseUrl,
      pool: { min: 0, max: 2 },
    });
  });

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('isr_outbox');
    await knex.schema.createTable('isr_outbox', (table) => {
      table.bigIncrements('id').primary();
      table.jsonb('payload').notNullable();
      table.string('reason').notNullable();
      table.string('status').notNullable();
      table.integer('attempt_count').notNullable().defaultTo(0);
      table.timestamp('next_attempt_at', { useTz: true }).notNullable();
      table.timestamp('locked_at', { useTz: true }).nullable();
      table.uuid('lock_token').nullable();
      table.text('last_error').nullable();
    });
  });

  afterAll(async () => {
    if (!knex) return;
    await knex.schema.dropTableIfExists('isr_outbox');
    await knex.destroy();
  });

  it('repairs JSONB commands idempotently without changing delivery ownership', async () => {
    const now = new Date('2026-07-31T14:00:00.000Z');
    const lockToken = '11111111-1111-4111-8111-111111111111';
    const [pending, processing, unrelated, delivered] = await knex('isr_outbox')
      .insert([
        {
          payload: JSON.stringify({
            paths: ['/', '/sitemap_index.xml', '/ugreen/', '/ugreen-deals/'],
            scopes: ['sitemap', 'routes'],
          }),
          reason: 'api::brand.brand update',
          status: 'pending',
          attempt_count: 604,
          next_attempt_at: now,
          last_error: 'gateway skipped 1 path(s): /ugreen-deals/',
        },
        {
          payload: JSON.stringify({
            paths: ['/', '/sitemap_index.xml', '/deal/4037/'],
            scopes: ['sitemap', 'routes'],
          }),
          reason: 'api::deal.deal delete',
          status: 'processing',
          attempt_count: 95,
          next_attempt_at: now,
          locked_at: now,
          lock_token: lockToken,
          last_error: 'gateway skipped 1 path(s): /deal/4037/',
        },
        {
          payload: JSON.stringify({ paths: ['/', '/unknown-deals/'] }),
          reason: 'unrelated task',
          status: 'pending',
          next_attempt_at: now,
          last_error: 'gateway skipped 1 path(s): /unknown-deals/',
        },
        {
          payload: JSON.stringify({ paths: ['/', '/old-deals/'] }),
          reason: 'api::store.store update',
          status: 'delivered',
          next_attempt_at: now,
          last_error: 'gateway skipped 1 path(s): /old-deals/',
        },
      ])
      .returning(['id']);

    await migration.up(knex);
    await migration.up(knex);

    const rows = await knex('isr_outbox').orderBy('id');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      id: pending?.id,
      status: 'pending',
      attempt_count: 604,
      locked_at: null,
      lock_token: null,
    });
    expect(rows[0]?.payload.optionalPaths).toEqual(['/ugreen-deals/']);
    expect(rows[1]).toMatchObject({
      id: processing?.id,
      status: 'processing',
      attempt_count: 95,
      lock_token: lockToken,
    });
    expect(new Date(rows[1]?.locked_at).toISOString()).toBe(now.toISOString());
    expect(rows[1]?.payload.optionalPaths).toEqual(['/deal/4037/']);
    expect(rows[2]).toMatchObject({ id: unrelated?.id, status: 'pending' });
    expect(rows[2]?.payload.optionalPaths).toBeUndefined();
    expect(rows[3]).toMatchObject({ id: delivered?.id, status: 'delivered' });
    expect(rows[3]?.payload.optionalPaths).toBeUndefined();
  });
});
