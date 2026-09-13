import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import { isPostgresConnection } from '../utils/database-dialect';

export const TELEGRAM_LEASE_TABLE = 'telegram_worker_leases';
const LEASE_MS = 120_000;

export class TelegramLeaseLost extends Error {
  constructor() { super('Telegram worker ownership changed'); }
}
export type TelegramLease = { assertOwned: (trx: any) => Promise<void> };

/** The lease survives process crashes without reserving a pool connection. */
export async function withTelegramLease<T>(
  strapi: Core.Strapi, key: string, work: (lease: TelegramLease) => Promise<T>,
): Promise<T | null> {
  const db = strapi.db.connection;
  const owner = randomUUID();
  await db(TELEGRAM_LEASE_TABLE).insert({ key, owner: '', expires_at: new Date(0) }).onConflict('key').ignore();
  const acquired = await db(TELEGRAM_LEASE_TABLE).where({ key }).andWhere('expires_at', '<=', new Date())
    .update({ owner, expires_at: new Date(Date.now() + LEASE_MS) });
  if (!acquired) return null;
  let lost = false;
  let heartbeat: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (heartbeat || lost) return;
    heartbeat = (async () => {
      const renewed = await db(TELEGRAM_LEASE_TABLE).where({ key, owner }).andWhere('expires_at', '>', new Date())
        .update({ expires_at: new Date(Date.now() + LEASE_MS) });
      if (!renewed) lost = true;
    })().catch(() => { lost = true; }).finally(() => { heartbeat = null; });
  }, 30_000);
  timer.unref();
  try {
    return await work({ assertOwned: async trx => {
      if (lost) throw new TelegramLeaseLost();
      let query = trx(TELEGRAM_LEASE_TABLE).where({ key, owner }).andWhere('expires_at', '>', new Date());
      if (isPostgresConnection(trx)) query = query.forUpdate();
      if (!(await query.first())) throw new TelegramLeaseLost();
    } });
  } finally {
    clearInterval(timer);
    await heartbeat;
    await db(TELEGRAM_LEASE_TABLE).where({ key, owner }).update({ expires_at: new Date(0) });
  }
}
