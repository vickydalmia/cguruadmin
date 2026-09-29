import { AsyncLocalStorage } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { enqueueTelegramFeedRefresh } from './feed-refresh';

const batches = new AsyncLocalStorage<{ changed: boolean }>();
export function markTelegramFeedBatch(): boolean {
  const batch = batches.getStore();
  if (!batch) return false;
  batch.changed = true;
  return true;
}

/** Content and its one invalidation commit together, including nested writes. */
export async function withTelegramFeedBatch<T>(strapi: Core.Strapi, work: (trx: any) => Promise<T>): Promise<T> {
  if (batches.getStore()) return strapi.db.transaction(({ trx }: any) => work(trx));
  const batch = { changed: false };
  return batches.run(batch, () => strapi.db.transaction(async ({ trx }: any) => {
    const result = await work(trx);
    if (batch.changed) await enqueueTelegramFeedRefresh(strapi);
    return result;
  }));
}
