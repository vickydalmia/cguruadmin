import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knexFactory, { type Knex } from 'knex';

// Local development may run on SQLite (docs/deployment.md). The upgrade
// migrations must not stop such an app from booting: a fresh database has no
// content tables yet, an older one has them with NULL locales.
const identity = require('../../database/migrations/2026.09.03T00.00.00.make-localized-document-identity-locale-aware.js');
const preserve = require('../../database/migrations/2026.09.08T00.00.00.preserve-legacy-english-content.js');
const revision = require('../../database/migrations/2026.09.09T00.00.00.align-configuration-revision.js');

describe('English upgrade migrations on SQLite', () => {
  let knex: Knex;

  beforeEach(() => {
    knex = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('runs on a fresh database before any content table exists', async () => {
    await identity.up(knex);
    await preserve.up(knex);
    await revision.up(knex);
  });

  it('repairs NULL locales and revisions on an existing development database', async () => {
    for (const table of ['stores', 'homepages']) {
      await knex.schema.createTable(table, (t) => {
        t.increments('id');
        t.string('document_id');
        t.string('locale');
      });
    }
    await knex('stores').insert([
      { document_id: 'a', locale: null },
      { document_id: 'b', locale: '  ' },
      { document_id: 'c', locale: 'ar' },
    ]);
    await knex('homepages').insert({ document_id: 'h', locale: null });
    await knex.schema.createTable('site_configurations', (t) => {
      t.increments('id');
      t.integer('configuration_revision');
    });
    await knex('site_configurations').insert({ configuration_revision: null });

    await identity.up(knex);
    await preserve.audit(knex);
    await preserve.up(knex);
    await revision.up(knex);

    expect((await knex('stores').orderBy('document_id').pluck('locale'))).toEqual(['en', 'en', 'ar']);
    expect(await knex('homepages').pluck('locale')).toEqual(['en']);
    expect(await knex('site_configurations').pluck('configuration_revision')).toEqual([0]);
  });

  it('still reports duplicate English rows instead of changing them', async () => {
    await knex.schema.createTable('brands', (t) => {
      t.increments('id');
      t.string('document_id');
      t.string('locale');
    });
    await knex('brands').insert([{ document_id: 'dup', locale: null }, { document_id: 'dup', locale: 'en' }]);
    await expect(preserve.up(knex)).rejects.toThrow(/English locale repair conflict in brands/);
    expect(await knex('brands').whereNull('locale').count({ n: '*' })).toEqual([{ n: 1 }]);
  });
});
