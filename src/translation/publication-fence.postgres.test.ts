import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fenceTranslationPublication } from './publication-fence';
import { setEnabledContentLocaleCodesForTest } from './locales/registry';
import { acquireWriteSerializationLock } from '../utils/write-serialization';

const databaseUrl = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('publication fencing on PostgreSQL', () => {
  let db: Knex;
  let strapi: any;
  const updatedAt = new Date('2026-09-01T00:00:00Z');
  const context = () => ({ sourceEntry: { id: 1, updatedAt }, operation: 'upsert' as const,
    targetLocale: 'ar', targetRowExisted: true, plan: null });
  beforeAll(async () => {
    db = knexFactory({ client: 'pg', connection: databaseUrl, pool: { min: 0, max: 2 } });
    strapi = { db: { connection: db, metadata: { get: () => ({ tableName: 'publication_sources' }) } } };
    await db.schema.dropTableIfExists('publication_sources');
    await db.schema.createTable('publication_sources', (t) => {
      t.integer('id').primary(); t.string('document_id'); t.string('locale'); t.timestamp('updated_at');
    });
  });
  beforeEach(async () => {
    setEnabledContentLocaleCodesForTest(['ar']);
    await db('publication_sources').delete();
    await db('publication_sources').insert({ id: 1, document_id: 'source', locale: 'en', updated_at: updatedAt });
  });
  afterAll(async () => {
    setEnabledContentLocaleCodesForTest([]);
    if (db) { await db.schema.dropTableIfExists('publication_sources'); await db.destroy(); }
  });

  it('rejects changed English revisions, disabled languages, and lost leases', async () => {
    await db('publication_sources').update({ updated_at: new Date() });
    await expect(db.transaction((trx) => fenceTranslationPublication(strapi, trx, 'test', 'source', context())))
      .rejects.toThrow();
    await db('publication_sources').update({ updated_at: updatedAt });
    setEnabledContentLocaleCodesForTest([]);
    await expect(db.transaction((trx) => fenceTranslationPublication(strapi, trx, 'test', 'source', context())))
      .rejects.toThrow();
    setEnabledContentLocaleCodesForTest(['ar']);
    await expect(db.transaction((trx) => fenceTranslationPublication(strapi, trx, 'test', 'source', {
      ...context(), assertPublicationLease: async () => { throw new Error('lease moved'); },
    }))).rejects.toThrow('lease moved');
  });

  it('holds the English row through commit using one content connection', async () => {
    const trx = await db.transaction();
    await acquireWriteSerializationLock(strapi, 'identity', trx);
    await fenceTranslationPublication(strapi, trx, 'test', 'source', context());
    let edited = false;
    const edit = db('publication_sources').where({ id: 1 }).update({ updated_at: new Date() })
      .then(() => { edited = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(edited).toBe(false);
    await trx.commit();
    await edit;
    expect(edited).toBe(true);
  });
});
