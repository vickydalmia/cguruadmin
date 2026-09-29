import knex from 'knex';
import { expect, it, vi } from 'vitest';
import { insertIsrOutboxEvent } from '../isr-outbox/store';

it('coalesces feed bursts without postponing delivery or overwriting an active delivery', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const migration = require('../../database/migrations/2026.07.24T00.00.00.create-isr-outbox.js');
  await migration.up(db);
  await db.schema.alterTable('isr_outbox', table => table.string('delivery_key'));
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const start = Date.now();
    const enqueue = (path: string) => db.transaction(trx => insertIsrOutboxEvent(trx, {
      eventKey: 'telegram-feed:page', reason: 'feed change', payload: { paths: [path] },
    }));
    await enqueue('/join-telegram/');
    for (let i = 0; i < 1000; i++) {
      vi.setSystemTime(start + i * 4);
      await enqueue('/join-telegram/');
    }
    let rows = await db('isr_outbox');
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].next_attempt_at).getTime()).toBe(start + 5000);
    expect(JSON.parse(rows[0].payload).paths).toEqual(['/join-telegram/']);
    await db('isr_outbox').where({ id: rows[0].id }).update({ status: 'processing' });
    await enqueue('/new-telegram-slug/');
    rows = await db('isr_outbox').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].payload).paths).toEqual(['/join-telegram/']);
    expect(JSON.parse(rows[1].payload).paths).toEqual(['/new-telegram-slug/']);
  } finally { vi.useRealTimers(); await db.destroy(); }
});
