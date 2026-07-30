import { describe, expect, it } from 'vitest';
import type { Core } from '@strapi/strapi';
import sitemapService from './sitemap';

// One store entity per test run; the aggregate stubs decide what its offer
// queries return — or whether they throw.
type SourceBehavior =
  | { rows: Array<{ entity_id: number; last_modified: string | null; live_count: number }> }
  | { fail: true };

function chainable(behavior: SourceBehavior) {
  const chain: any = {};
  for (const method of ['join', 'where', 'andWhere', 'groupBy', 'select', 'max']) {
    chain[method] = () => chain;
  }
  // `.count()` ends the chain; knex builders are thenable, so resolve/reject
  // happens at await time exactly like the real driver.
  chain.count = () =>
    'fail' in behavior
      ? Promise.reject(new Error('relation does not exist'))
      : Promise.resolve(behavior.rows);
  return chain;
}

function fakeStrapi(sources: Record<string, SourceBehavior>): Core.Strapi {
  const connection = (linkTable: string) =>
    chainable(sources[linkTable] ?? { rows: [] });
  return {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    db: { connection },
    documents: () => ({
      // One store row; every other entity kind returns empty.
      findMany: async ({ start }: any) =>
        start === 0
          ? [{ id: 7, documentId: 'doc-7', slug: 'nike-coupons', updatedAt: '2026-07-01T00:00:00.000Z' }]
          : [],
    }),
  } as unknown as Core.Strapi;
}

async function storeRow(sources: Record<string, SourceBehavior>) {
  const rows = await sitemapService({ strapi: fakeStrapi(sources) }).listSitemapEntities();
  const row = rows.find((entry) => entry.documentId === 'doc-7');
  expect(row).toBeDefined();
  return row!;
}

describe('listSitemapEntities liveOfferCount', () => {
  it('publishes the summed count when both source queries run', async () => {
    const row = await storeRow({
      coupons_stores_lnk: {
        rows: [{ entity_id: 7, last_modified: '2026-07-20T00:00:00.000Z', live_count: 3 }],
      },
      deals_stores_lnk: {
        rows: [{ entity_id: 7, last_modified: null, live_count: 2 }],
      },
    });
    expect(row.liveOfferCount).toBe(5);
    expect(row.offersUpdatedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('publishes a confirmed 0 when both queries run and find nothing', async () => {
    const row = await storeRow({
      coupons_stores_lnk: { rows: [] },
      deals_stores_lnk: { rows: [] },
    });
    expect(row.liveOfferCount).toBe(0);
  });

  it('OMITS the count when one source query fails (partial aggregate is not a 0)', async () => {
    // The frontend drops liveOfferCount === 0 entities from the sitemap, so a
    // failed coupons query publishing "0" would collapse the store shards.
    // Omission makes the frontend fail open and keep every URL.
    const row = await storeRow({
      coupons_stores_lnk: { fail: true },
      deals_stores_lnk: {
        rows: [{ entity_id: 7, last_modified: '2026-07-20T00:00:00.000Z', live_count: 2 }],
      },
    });
    expect(row.liveOfferCount).toBeUndefined();
    expect('liveOfferCount' in row).toBe(false);
    // lastmod decoration from the surviving query is still welcome.
    expect(row.offersUpdatedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('omits the count entirely when the connection is unavailable', async () => {
    const strapi = fakeStrapi({});
    (strapi.db as any).connection = undefined;
    const rows = await sitemapService({ strapi }).listSitemapEntities();
    const row = rows.find((entry) => entry.documentId === 'doc-7');
    expect(row).toBeDefined();
    expect('liveOfferCount' in row!).toBe(false);
  });
});
