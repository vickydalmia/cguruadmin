import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@strapi/strapi';

import { INDIA_DEFAULT_CONFIGURATION } from '../../site-configuration/services/country-registry';

const mocks = vi.hoisted(() => ({
  cachedSiteConfiguration: vi.fn(),
}));

vi.mock('../../site-configuration/services/cached-configuration', () => ({
  cachedSiteConfiguration: mocks.cachedSiteConfiguration,
}));

import sitemapService from './sitemap';

// One store entity per test run; the aggregate stubs decide what its offer
// queries return — or whether they throw.
type SourceBehavior =
  | { rows: Array<{ entity_id: number; last_modified: string | null; live_count: number }> }
  | { fail: true };

type ChainCall = { method: string; arg: unknown };

function chainable(behavior: SourceBehavior, record?: ChainCall[]) {
  const chain: any = {};
  for (const method of ['join', 'where', 'andWhere', 'whereRaw', 'from', 'groupBy', 'select', 'max']) {
    chain[method] = (...args: unknown[]) => {
      record?.push({ method, arg: args[0] });
      return chain;
    };
  }
  // Exercises the subquery callback the way knex compiles it, without
  // recording its internal calls against the outer query.
  chain.whereExists = (callback: unknown) => {
    record?.push({ method: 'whereExists', arg: callback });
    if (typeof callback === 'function') callback(chainable({ rows: [] }));
    return chain;
  };
  // `.count()` ends the chain; knex builders are thenable, so resolve/reject
  // happens at await time exactly like the real driver.
  chain.count = () =>
    'fail' in behavior
      ? Promise.reject(new Error('relation does not exist'))
      : Promise.resolve(behavior.rows);
  return chain;
}

function fakeStrapi(
  sources: Record<string, SourceBehavior>,
  callLog?: Record<string, ChainCall[]>,
): Core.Strapi {
  const connection = (linkTable: string) => {
    const record = callLog ? (callLog[linkTable] ??= []) : undefined;
    return chainable(sources[linkTable] ?? { rows: [] }, record);
  };
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
  beforeEach(() => {
    mocks.cachedSiteConfiguration.mockReset();
    mocks.cachedSiteConfiguration.mockResolvedValue(INDIA_DEFAULT_CONFIGURATION);
  });

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

  it('never queries a feature-disabled source and publishes the rest as authoritative', async () => {
    // Feature-disabled offers do not render (EntityLinkPolicy empties the
    // sources), so they must not keep a page in the sitemap — and skipping
    // them is an authoritative zero, not an incomplete aggregate.
    mocks.cachedSiteConfiguration.mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      couponsEnabled: false,
    });
    const calls: Record<string, ChainCall[]> = {};
    const rows = await sitemapService({
      strapi: fakeStrapi(
        {
          coupons_stores_lnk: {
            rows: [{ entity_id: 7, last_modified: '2026-07-25T00:00:00.000Z', live_count: 3 }],
          },
          deals_stores_lnk: {
            rows: [{ entity_id: 7, last_modified: '2026-07-20T00:00:00.000Z', live_count: 2 }],
          },
        },
        calls,
      ),
    }).listSitemapEntities();

    const row = rows.find((entry) => entry.documentId === 'doc-7');
    expect(calls.coupons_stores_lnk).toBeUndefined();
    expect(row!.liveOfferCount).toBe(2);
    expect(row!.offersUpdatedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('publishes a confirmed 0 when every offer feature is disabled', async () => {
    mocks.cachedSiteConfiguration.mockResolvedValue({
      ...INDIA_DEFAULT_CONFIGURATION,
      couponsEnabled: false,
      productDealsEnabled: false,
    });
    const row = await storeRow({
      coupons_stores_lnk: {
        rows: [{ entity_id: 7, last_modified: '2026-07-25T00:00:00.000Z', live_count: 3 }],
      },
      deals_stores_lnk: {
        rows: [{ entity_id: 7, last_modified: '2026-07-20T00:00:00.000Z', live_count: 2 }],
      },
    });
    expect(row.liveOfferCount).toBe(0);
    expect(row.offersUpdatedAt).toBeUndefined();
  });

  it('applies deal card eligibility to the deals source only', async () => {
    // Mirrors the frontend render rules: deals count only when their section
    // is visible and they can produce a card; only the store rail is
    // categorized. Coupons carry none of these conditions.
    const calls: Record<string, ChainCall[]> = {};
    await sitemapService({ strapi: fakeStrapi({}, calls) }).listSitemapEntities();

    const rawClauses = (table: string) =>
      calls[table]!.filter((call) => call.method === 'whereRaw').map((call) =>
        String(call.arg),
      );
    const existsCount = (table: string) =>
      calls[table]!.filter((call) => call.method === 'whereExists').length;

    expect(rawClauses('deals_stores_lnk').join('\n')).toContain('show_trending_deals');
    expect(rawClauses('deals_stores_lnk').join('\n')).toContain('affiliate_link');
    // dealImage presence + (store only) category membership.
    expect(existsCount('deals_stores_lnk')).toBe(2);
    // Brand/category/bank rails are flat: image check only.
    expect(existsCount('deals_brands_lnk')).toBe(1);
    expect(existsCount('deals_categories_lnk')).toBe(1);
    expect(existsCount('deals_banks_lnk')).toBe(1);

    expect(rawClauses('coupons_stores_lnk')).toEqual([]);
    expect(existsCount('coupons_stores_lnk')).toBe(0);
  });
});
