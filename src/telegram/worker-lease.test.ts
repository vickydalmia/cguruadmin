import { afterEach, expect, it } from 'vitest';
import { ingestionCms } from './ingest-test-cms.test-utils';
import { TELEGRAM_LEASE_TABLE, withTelegramLease } from './worker-lease';
import { savePendingMessages, TELEGRAM_PENDING_TABLE } from './pending-store';
import { retryTelegramProcessing, listTelegramProcessing } from './admin-processing';

const databases: any[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.destroy(); });
async function cms() { const result = await ingestionCms({}); databases.push(result.db); return result; }

it('releases the only pool connection during external work and fences an expired owner', async () => {
  const { strapi, db } = await cms();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = withTelegramLease(strapi, 'media', async lease => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
    await expect(db.transaction(trx => lease.assertOwned(trx))).rejects.toThrow(/ownership/);
  });
  await ready;
  expect(await db.raw('select 1 as ok')).toBeTruthy();
  expect(await withTelegramLease(strapi, 'media', async () => true)).toBeNull();
  await db(TELEGRAM_LEASE_TABLE).where({ key: 'media' }).update({ expires_at: new Date(0) });
  expect(await withTelegramLease(strapi, 'media', async () => true)).toBe(true);
  release();
  await first;
});

it('keeps fresh-country setup empty after a Telegram Page seed', async () => {
  const { db } = await cms();
  await db.schema.createTable('telegram_pages', t => t.increments('id'));
  await db('telegram_pages').insert({ id: 1 });
  const { assertEmptyCountryDatabase } = require('../../database/country-bootstrap.js');
  await expect(assertEmptyCountryDatabase(db)).resolves.toBeUndefined();
  await db.schema.createTable('stores', t => t.increments('id'));
  await db('stores').insert({ id: 1 });
  await expect(assertEmptyCountryDatabase(db)).rejects.toThrow(/stores/);
});

it('bounds the private backlog, stores only the newest revision and rejects stale admin retries', async () => {
  const { strapi, db } = await cms();
  const updates = Array.from({ length: 100 }, (_, i) => ({ update_id: i + 1, channel_post: {
    message_id: i + 1, date: 1000 + i, chat: { id: -1001, type: 'channel' }, text: `Offer ${i}`,
  } }));
  await db.transaction(trx => savePendingMessages(trx, 'connection', updates, 60, new Date()));
  expect(await db(TELEGRAM_PENDING_TABLE)).toHaveLength(60);
  const job = await db(TELEGRAM_PENDING_TABLE).where({ message_id: 100 }).first();
  await strapi.store().set({ key: 'state', value: { connectionKey: 'connection' } });
  await db(TELEGRAM_PENDING_TABLE).where({ id: job.id }).update({ stage: 'blocked', error_code: 'FAL_SUBMISSION_UNCERTAIN' });
  expect(await retryTelegramProcessing(strapi, job.id, 99, true)).toBe(false);
  expect(await retryTelegramProcessing(strapi, job.id, 100, false)).toBe(false);
  expect(await retryTelegramProcessing(strapi, job.id, 100, true)).toBe(true);
  expect((await db(TELEGRAM_PENDING_TABLE).where({ id: job.id }).first()).stage).toBe('pending');
  const status = await listTelegramProcessing(strapi, 1);
  expect(status.jobs).toHaveLength(20);
  expect(status.jobs[0]).not.toHaveProperty('message');
  expect(status.jobs[0]).not.toHaveProperty('connection_key');
});
