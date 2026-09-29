import knexFactory, { type Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import { installMigrationLockTimeout } from '../register/migration-lock-timeout';
const prepareDeliveries = require('../../database/migrations/2026.09.04T23.59.59.prepare-delivery-identities.js');
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireWriteSerializationLock } from './write-serialization';
const repair = require('../../database/migrations/2026.09.08T00.00.00.preserve-legacy-english-content.js');
const prior = require('../../database/migrations/2026.09.03T00.00.00.make-localized-document-identity-locale-aware.js');
const url = process.env.UNIQUE_CODE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('legacy English production upgrade', () => {
  let db: Knex;
  let admin: Knex;
  const schema = `english_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = knexFactory({ client: 'pg', connection: url });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    db = knexFactory({ client: 'pg', connection: url, searchPath: [schema], pool: { min: 0, max: 3 } });
    for (const table of repair.TABLES) {
      await db.schema.createTable(table, (t) => {
        t.increments('id'); t.string('document_id'); t.string('locale');
        t.text('content'); t.timestamp('updated_at');
      });
      await db(table).insert({ document_id: `${table}-english`, content: 'Existing English', updated_at: new Date('2026-01-01') });
    }
    await db.schema.createTable('homepage_components', (t) => {
      t.integer('homepage_id').references('id').inTable('homepages'); t.text('content');
    });
    await db('homepage_components').insert({ homepage_id: 1, content: 'Existing component' });
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) { await admin.raw('DROP SCHEMA ?? CASCADE', [schema]); await admin.destroy(); }
  });
  it('repairs all 24 types after the six-table migration, preserving content and links', async () => {
    const before = await db('homepages').first();
    await prior.up(db);
    await repair.audit(db);
    await repair.up(db);
    await repair.up(db);
    for (const table of repair.TABLES) {
      expect(await db(table).where({ locale: 'en' }).count('* as count').first()).toEqual({ count: '1' });
    }
    expect(await db('homepages').first()).toEqual({ ...before, locale: 'en' });
    expect(await db('homepage_components').first()).toEqual({ homepage_id: 1, content: 'Existing component' });
  });
  it('refuses conflicting single types before changing any legacy rows', async () => {
    await db('homepages').update({ locale: null });
    await db('menus').insert({ document_id: 'second-menu', locale: 'en', content: 'Do not delete' });
    await expect(repair.audit(db)).rejects.toThrow('Multiple single-type');
    await expect(repair.up(db)).rejects.toThrow('Multiple single-type');
    expect((await db('homepages').first()).locale).toBeNull();
    await db('menus').where({ document_id: 'second-menu' }).delete();
  });
  it('adds a missing locale column before Strapi schema sync and preserves translations', async () => {
    await db.schema.alterTable('jobs', (t) => t.dropColumn('locale'));
    await db('homepages').insert({ document_id: 'homepages-english', locale: 'ar', content: 'Arabic' });
    await repair.audit(db);
    await repair.up(db);
    expect((await db('jobs').first()).locale).toBe('en');
    expect((await db('homepages').where({ locale: 'ar' }).first()).content).toBe('Arabic');
  });
  it('bulk prepares delivery identities without changing existing keys', async () => {
    await db.schema.createTable('isr_outbox', (t) => { t.increments('id'); t.uuid('delivery_key'); });
    const existing = randomUUID();
    await db('isr_outbox').insert([{ delivery_key: existing }, ...Array.from({ length: 100 }, () => ({ delivery_key: null }))]);
    await db.transaction((trx) => prepareDeliveries.up(trx));
    await db.transaction((trx) => prepareDeliveries.up(trx));
    const rows = await db('isr_outbox').select('delivery_key').orderBy('id');
    expect(rows[0].delivery_key).toBe(existing);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(101);
    expect(rows.every((row) => row.delivery_key)).toBe(true);
  });
  it('applies a transaction-local lock deadline before immutable migrations run', async () => {
    installMigrationLockTimeout({ dirs: { app: { root: process.cwd() } } } as any);
    await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '12s'");
      await prior.up(trx);
      expect((await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout).toBe('15s');
    });
    expect((await db.raw('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  });
  it('restores the caller timeout and serializes saves on the same connection', async () => {
    const strapi = { db: { connection: db } } as any;
    await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '12s'");
      await acquireWriteSerializationLock(strapi, 'identity', trx);
      expect((await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout).toBe('12s');
      const other = await db.transaction();
      await other.raw("SET LOCAL lock_timeout = '100ms'");
      await expect(other.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['cguru:document-write', 'identity']))
        .rejects.toMatchObject({ code: '55P03' });
      await other.rollback();
    });
    await db.transaction((trx) => acquireWriteSerializationLock(strapi, 'identity', trx));
  });
});
