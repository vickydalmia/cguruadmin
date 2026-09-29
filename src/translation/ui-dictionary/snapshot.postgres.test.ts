import knexFactory, { type Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UiDictionaryStore } from './store';
const url = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
const { preflightDatabaseConfig, checkDatabaseCountry } = require('../../../deploy/scripts/check-country.cjs');
const createDictionary = require('../../../database/migrations/2026.09.01T00.00.00.create-ui-dictionary.js');
const alignRevision = require('../../../database/migrations/2026.09.09T00.00.00.align-configuration-revision.js');
(url ? describe : describe.skip)('schema-aware preflight and dictionary snapshot', () => {
  const schema = `dictionary_${randomUUID().replaceAll('-', '')}`;
  let db: Knex;
  let admin: Knex;
  let strapi: any;
  beforeAll(async () => {
    admin = knexFactory({ client: 'pg', connection: url });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    // Use the production schema resolver, with capacity for a concurrent writer.
    db = knexFactory({ ...preflightDatabaseConfig({ connection: { client: 'pg', connection: {
      connectionString: url, schema,
    } } }), pool: { min: 0, max: 3 } });
    await db.schema.createTable('site_configurations', (t) => {
      t.increments('id'); t.string('country_code'); t.integer('configuration_revision');
    });
    await db('site_configurations').insert({ country_code: 'AE' });
    await db.schema.createTable('strapi_core_store_settings', (t) => {
      t.increments('id'); t.string('key').unique(); t.text('value'); t.string('type'); t.string('environment'); t.string('tag');
    });
    await createDictionary.up(db);
    strapi = { db: { connection: db, transaction: (callback: any) => db.transaction((trx) => callback({ trx })) } };
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) { await admin.raw('DROP SCHEMA ?? CASCADE', [schema]); await admin.destroy(); }
  });
  it('checks the configured schema and repairs revision NULL values idempotently', async () => {
    await expect(checkDatabaseCountry(db, 'AE', '')).resolves.toBeUndefined();
    await expect(checkDatabaseCountry(db, 'US', '')).rejects.toThrow('does not match');
    await alignRevision.up(db); await alignRevision.up(db);
    expect((await db('site_configurations').first()).configuration_revision).toBe(0);
    await expect(db('site_configurations').insert({ country_code: 'AE', configuration_revision: null })).rejects.toMatchObject({ code: '23502' });
    const column = await admin('information_schema.columns').where({ table_schema: schema,
      table_name: 'site_configurations', column_name: 'configuration_revision' }).first();
    expect(column.is_nullable).toBe('NO');
    expect(column.column_default).toBe('0');
  });
  it('never labels old translated messages with a concurrently committed new version', async () => {
    const reader = new UiDictionaryStore(strapi);
    const writer = new UiDictionaryStore(strapi);
    await writer.syncCatalogue({ version: 'old', entries: { 'common.old': { text: 'Old' } } } as any);
    await writer.writeManualTranslation('ar', 'common.old', 'قديم', null);
    await expect(reader.publicDictionary('ar')).resolves.toMatchObject({
      version: 'old', ready: true, messages: { 'common.old': 'قديم' },
    });
    const original = reader.readMeta.bind(reader);
    const interception = vi.spyOn(reader, 'readMeta').mockImplementationOnce(async (trx) => {
      expect((await trx.raw('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');
      expect((await trx.raw('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
      const meta = await original(trx);
      await writer.syncCatalogue({ version: 'new', entries: {
        'common.old': { text: 'Old' }, 'common.new': { text: 'New' },
      } } as any);
      return meta;
    });
    try {
      const duringUpdate = await reader.publicDictionary('ar');
      expect(duringUpdate).toMatchObject({ version: 'old', ready: true, messages: { 'common.old': 'قديم' } });
    } finally {
      interception.mockRestore();
    }
    expect(await reader.publicDictionary('ar')).toMatchObject({ version: 'new', ready: false });
  });
});
