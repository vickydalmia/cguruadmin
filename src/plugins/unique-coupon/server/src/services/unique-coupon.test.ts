import { describe, expect, it, vi } from 'vitest';

import uniqueCouponService from './unique-coupon';

type HarnessOptions = {
  client?: string;
  poolRow?: { id: number; name?: string; document_id?: string } | null;
  existingCodes?: string[];
  redeemCode?: {
    id: number;
    code: string;
    is_used: boolean;
    version: number;
  } | null;
  stats?: { total: string; used: string };
};

function createHarness({
  client = 'pg',
  poolRow = { id: 7, name: 'Summer', document_id: 'pool-doc' },
  existingCodes = [],
  redeemCode = null,
  stats = { total: '0', used: '0' },
}: HarnessOptions = {}) {
  let insertedId = 100;
  const calls = {
    tables: [] as string[],
    joins: [] as string[],
    forUpdate: 0,
    codeInserts: [] as any[][],
    linkInserts: [] as any[][],
    updates: [] as any[],
    increments: [] as Array<{ table: string; column: string; amount: number }>,
  };

  function makeBuilder(table: string) {
    const state = {
      first: false,
      insertRows: undefined as any[] | undefined,
      updateValues: undefined as any,
    };
    const chain: any = {
      join: (joined: string) => {
        calls.joins.push(joined);
        return chain;
      },
      where: () => chain,
      whereIn: () => chain,
      select: () => chain,
      orderBy: () => chain,
      count: () => chain,
      sum: () => chain,
      first: () => {
        state.first = true;
        return chain;
      },
      forUpdate: () => {
        calls.forUpdate += 1;
        return chain;
      },
      insert: (rows: any[]) => {
        state.insertRows = rows;
        if (table === 'unique_codes') calls.codeInserts.push(rows);
        if (table === 'unique_codes_pool_lnk') calls.linkInserts.push(rows);
        return chain;
      },
      returning: async () =>
        (state.insertRows ?? []).map((row) => ({
          id: insertedId++,
          code: row.code,
        })),
      update: (values: any) => {
        state.updateValues = values;
        calls.updates.push(values);
        return chain;
      },
      increment: (column: string, amount: number) => {
        calls.increments.push({ table, column, amount });
        return Promise.resolve(1);
      },
      then: (resolve: any, reject: any) => {
        let result: any;
        if (table === 'unique_coupon_pools') {
          result = poolRow;
        } else if (table.startsWith('unique_codes as')) {
          if (state.first) {
            result = redeemCode;
          } else {
            result = existingCodes.map((code) => ({ code }));
          }
        } else if (table === 'unique_codes' && state.updateValues) {
          result = 1;
        } else {
          result = state.insertRows ?? [];
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    calls.tables.push(table);
    return chain;
  }

  const trx: any = Object.assign(
    (table: string) => makeBuilder(table),
    {
      client: { config: { client } },
      raw: vi.fn((sql: string) => {
        if (sql.includes('COUNT(*)')) return stats;
        return {};
      }),
    },
  );
  const knex: any = Object.assign(
    (table: string) => makeBuilder(table),
    {
      client: { config: { client } },
      raw: trx.raw,
      transaction: (fn: (transaction: any) => Promise<any>) => fn(trx),
    },
  );
  const strapi = {
    db: { connection: knex },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;

  return {
    service: uniqueCouponService({ strapi }),
    calls,
    log: strapi.log,
  };
}

describe('importCodes with Strapi relation table', () => {
  it('inserts only missing codes and creates links without a duplicate pool id', async () => {
    const harness = createHarness({ existingCodes: ['B'] });

    const result = await harness.service.importCodes(
      'pool-doc',
      ['A', 'B', 'A', 'C'],
      2,
    );

    expect(result).toEqual({ imported: 2, skipped: 2, total: 4 });
    expect(harness.calls.forUpdate).toBe(1);
    expect(harness.calls.codeInserts.flat().map((row) => row.code)).toEqual([
      'A',
      'C',
    ]);
    expect(
      harness.calls.codeInserts.flat().every((row) => !('pool_id' in row)),
    ).toBe(true);
    expect(harness.calls.linkInserts.flat()).toEqual([
      {
        unique_code_id: 100,
        unique_coupon_pool_id: 7,
        unique_code_ord: 1,
      },
      {
        unique_code_id: 101,
        unique_coupon_pool_id: 7,
        unique_code_ord: 1,
      },
    ]);
    expect(harness.calls.increments).toEqual([
      {
        table: 'unique_coupon_pools',
        column: 'total_codes',
        amount: 2,
      },
    ]);
  });

  it('does not insert or change counters when every code already exists', async () => {
    const harness = createHarness({ existingCodes: ['A', 'B'] });

    await expect(
      harness.service.importCodes('pool-doc', ['A', 'B']),
    ).resolves.toEqual({ imported: 0, skipped: 2, total: 2 });
    expect(harness.calls.codeInserts).toEqual([]);
    expect(harness.calls.linkInserts).toEqual([]);
    expect(harness.calls.increments).toEqual([]);
  });

  it('keeps the POOL_NOT_FOUND error contract', async () => {
    const harness = createHarness({ poolRow: null });

    await expect(
      harness.service.importCodes('missing-pool', ['A']),
    ).rejects.toMatchObject({ code: 'POOL_NOT_FOUND' });
  });

  it('fails clearly outside PostgreSQL instead of using an unsafe fallback', async () => {
    const harness = createHarness({ client: 'better-sqlite3' });

    await expect(
      harness.service.importCodes('pool-doc', ['A']),
    ).rejects.toThrow(/require PostgreSQL/);
  });
});

describe('redeemCode with Strapi relation table', () => {
  it('locks the pool, selects through the link, redeems, and updates the counter', async () => {
    const harness = createHarness({
      redeemCode: {
        id: 22,
        code: 'PROMO-22',
        is_used: false,
        version: 3,
      },
    });

    await expect(harness.service.redeemCode('pool-doc')).resolves.toEqual({
      success: true,
      code: 'PROMO-22',
    });
    expect(harness.calls.joins).toContain(
      'unique_codes_pool_lnk as pool_link',
    );
    expect(harness.calls.forUpdate).toBe(2);
    expect(harness.calls.updates).toContainEqual(
      expect.objectContaining({ is_used: true, version: 4 }),
    );
    expect(harness.calls.increments).toContainEqual({
      table: 'unique_coupon_pools',
      column: 'used_codes',
      amount: 1,
    });
  });

  it('returns NO_CODES_AVAILABLE without changing the counter', async () => {
    const harness = createHarness({ redeemCode: null });

    await expect(harness.service.redeemCode('pool-doc')).resolves.toMatchObject({
      success: false,
      error: 'NO_CODES_AVAILABLE',
    });
    expect(harness.calls.increments).toEqual([]);
  });

  it('fails fast outside PostgreSQL', async () => {
    const harness = createHarness({ client: 'better-sqlite3' });

    await expect(harness.service.redeemCode('pool-doc')).rejects.toThrow(
      /require PostgreSQL/,
    );
  });
});
