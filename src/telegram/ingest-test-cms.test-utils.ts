import { AsyncLocalStorage } from 'node:async_hooks';
import knex from 'knex';
import { vi } from 'vitest';
import { markTelegramFeedBatch } from './feed-batch';

const migration = require('../../database/migrations/2026.09.13T00.00.00.telegram-durable-ingestion.js');

/** Test-only SQLite transactions, including the cursor; network/media remain mocked. */
export async function ingestionCms(config: any, initial: any[] = []) {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
  await migration.up(db);
  await require('../../database/migrations/2026.09.13T01.00.00.telegram-photo-diagnostics.js').up(db);
  await db.schema.createTable('fixture_posts', t => { t.string('id').primary(); t.text('data'); });
  await db.schema.createTable('fixture_state', t => { t.string('key').primary(); t.text('value'); });
  for (const row of initial) await db('fixture_posts').insert({ id: row.documentId, data: JSON.stringify(row) });
  const ambient = new AsyncLocalStorage<any>();
  const connection = () => ambient.getStore() ?? db;
  const created: any[] = [], updated: any[] = [], deleted: any[] = [], uploads: any[] = [], removedFiles: any[] = [];
  const files = new Map<number, any>();
  const rows = async () => (await connection()('fixture_posts')).map(row => JSON.parse(row.data));
  const strapi: any = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    store: () => ({
      get: async ({ key }: any) => { const row = await connection()('fixture_state').where({ key }).first(); return row ? JSON.parse(row.value) : null; },
      set: async ({ key, value }: any) => { await connection()('fixture_state').insert({ key, value: JSON.stringify(value) }).onConflict('key').merge(); },
    }),
    documents: vi.fn((uid: string) => {
      if (uid === 'api::telegram.telegram') return { findFirst: vi.fn(async () => config) };
      return {
        create: vi.fn(async ({ data }: any) => {
          const row = { documentId: `doc-${data.messageId}`, ...data, photo: data.photo ? { id: data.photo } : null };
          await connection()('fixture_posts').insert({ id: row.documentId, data: JSON.stringify(row) });
          created.push(data); markTelegramFeedBatch(); return row;
        }),
        update: vi.fn(async ({ documentId, data }: any) => {
          const row = (await rows()).find(row => row.documentId === documentId);
          const next = { ...row, ...data, ...('photo' in data ? { photo: data.photo ? { id: data.photo } : null } : {}) };
          await connection()('fixture_posts').where({ id: documentId }).update({ data: JSON.stringify(next) });
          updated.push({ documentId, data }); markTelegramFeedBatch(); return next;
        }),
        delete: vi.fn(async ({ documentId }: any) => {
          await connection()('fixture_posts').where({ id: documentId }).delete(); deleted.push(documentId); markTelegramFeedBatch();
        }),
      };
    }),
    db: {
      connection: db,
      transaction: async (work: any) => {
        if (ambient.getStore()) return work({ trx: ambient.getStore(), onCommit: () => {} });
        return db.transaction(trx => ambient.run(trx, () => work({ trx, onCommit: () => {} })));
      },
      query: vi.fn((uid: string) => ({
        findOne: vi.fn(async ({ where }: any) => {
          if (uid === 'plugin::upload.folder') return { id: 7 };
          if (uid === 'plugin::upload.file') return where.id ? files.get(where.id) ?? { id: where.id, hash: `photo-${where.id}` } : [...files.values()].find(file => file.name === where.name) ?? null;
          return (await rows()).find(row => where.photo ? row.photo?.id === where.photo.id : row.chatId === where.chatId && row.messageId === where.messageId) ?? null;
        }),
        findMany: vi.fn(async ({ offset = 0, limit = 100 }: any) =>
          (await rows()).sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime() || b.messageId - a.messageId).slice(offset, offset + limit)),
      })),
    },
    plugin: vi.fn(() => ({ service: vi.fn(() => ({
      upload: vi.fn(async (payload: any) => {
        uploads.push(payload);
        const file = { id: 100 + uploads.length, name: payload.data.fileInfo.name, hash: `file-${uploads.length}` };
        files.set(file.id, file); return [file];
      }),
      remove: vi.fn(async (file: any) => { removedFiles.push(file); files.delete(file.id); }),
    })) })),
  };
  return { strapi, db, rows, created, updated, deleted, uploads, removedFiles };
}
