import { describe, expect, it, vi } from 'vitest';

import uniqueCouponService from './unique-coupon';

type ImportHarnessOptions = {
  client?: string;
  /** `null` simulates a missing pool (an explicit `undefined` would just
   * re-trigger the destructuring default). */
  poolRow?: { id: number } | null;
  /** One entry per insert batch, in order (pg shape: `{ rowCount }`). */
  insertResults?: any[];
  /** One entry per awaited `count().first()`, in order (`{ count }`). */
  countResults?: any[];
};

/**
 * Minimal knex stand-in for importCodes: `trx` is callable per table, the
 * pool query chain is thenable (so `.forUpdate()` can be tacked on before the
 * await, exactly like knex), and every write is recorded for assertions.
 */
function createImportHarness({
  client = 'pg',
  poolRow = { id: 7 },
  insertResults = [],
  countResults = [],
}: ImportHarnessOptions = {}) {
  const calls = {
    forUpdate: 0,
    inserts: [] as any[][],
    increments: [] as Array<{ column: string; amount: number }>,
    updates: [] as any[],
    counts: 0,
  };
  const insertQueue = [...insertResults];
  const countQueue = [...countResults];

  const makePoolBuilder = () => {
    const builder: any = {
      where: () => builder,
      select: () => builder,
      first: () => builder,
      forUpdate: () => {
        calls.forUpdate += 1;
        return builder;
      },
      increment: (column: string, amount: number) => {
        calls.increments.push({ column, amount });
        return Promise.resolve(1);
      },
      update: (values: any) => {
        calls.updates.push(values);
        return Promise.resolve(1);
      },
      then: (resolve: any, reject: any) =>
        Promise.resolve(poolRow).then(resolve, reject),
    };
    return builder;
  };

  const makeCodesBuilder = () => {
    const builder: any = {
      where: () => builder,
      count: () => builder,
      first: () => builder,
      insert: (rows: any[]) => {
        calls.inserts.push(rows);
        return {
          onConflict: () => ({
            ignore: () => Promise.resolve(insertQueue.shift()),
          }),
        };
      },
      // Awaiting the builder is only ever the COUNT(*) fallback path.
      then: (resolve: any, reject: any) => {
        calls.counts += 1;
        return Promise.resolve(countQueue.shift()).then(resolve, reject);
      },
    };
    return builder;
  };

  const trx = Object.assign(
    (table: string) =>
      table === 'unique_coupon_pools' ? makePoolBuilder() : makeCodesBuilder(),
    { client: { config: { client } } },
  );
  const knex = {
    client: { config: { client } },
    transaction: (fn: (trx: any) => Promise<any>) => fn(trx),
  };
  const strapi = {
    db: { connection: knex },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;

  return { service: uniqueCouponService({ strapi }), calls };
}

describe('importCodes lock hold', () => {
  it('on Postgres increments total_codes by the rows actually inserted — no recount', async () => {
    // 5 codes in batches of 2; the middle batch hits an existing code, so the
    // driver reports 2 + 1 + 1 inserted rows.
    const harness = createImportHarness({
      insertResults: [{ rowCount: 2 }, { rowCount: 1 }, { rowCount: 1 }],
    });

    const result = await harness.service.importCodes(
      'pool-doc',
      ['A', 'B', 'C', 'D', 'E'],
      2,
    );

    expect(result).toEqual({ imported: 4, skipped: 1, total: 5 });
    expect(harness.calls.inserts).toHaveLength(3);
    // The pool row stays locked for the whole transaction...
    expect(harness.calls.forUpdate).toBe(1);
    // ...but the work under it is O(chunk): counter increment, no recount.
    expect(harness.calls.increments).toEqual([
      { column: 'total_codes', amount: 4 },
    ]);
    expect(harness.calls.counts).toBe(0);
    expect(harness.calls.updates).toEqual([]);
  });

  it('skips the counter write entirely when every code already existed', async () => {
    const harness = createImportHarness({
      insertResults: [{ rowCount: 0 }],
    });

    const result = await harness.service.importCodes('pool-doc', ['A', 'B'], 100);

    expect(result).toEqual({ imported: 0, skipped: 2, total: 2 });
    expect(harness.calls.increments).toEqual([]);
    expect(harness.calls.updates).toEqual([]);
  });

  it('falls back to a COUNT(*)-only recount on dialects without an insert row count', async () => {
    // mysql2's insert response carries no inserted-row figure through knex, so
    // the before/after count decides `imported` and total_codes is set
    // absolutely — but used_codes is no longer recalculated here.
    const harness = createImportHarness({
      client: 'mysql2',
      insertResults: [[0]],
      countResults: [{ count: 10 }, { count: 13 }],
    });

    const result = await harness.service.importCodes(
      'pool-doc',
      ['A', 'B', 'C'],
      100,
    );

    expect(result).toEqual({ imported: 3, skipped: 0, total: 3 });
    expect(harness.calls.counts).toBe(2);
    expect(harness.calls.forUpdate).toBe(1);
    expect(harness.calls.updates).toEqual([{ total_codes: 13 }]);
    expect(harness.calls.increments).toEqual([]);
  });

  it('keeps the POOL_NOT_FOUND error contract', async () => {
    const harness = createImportHarness({ poolRow: null });

    await expect(
      harness.service.importCodes('missing-pool', ['A']),
    ).rejects.toMatchObject({ code: 'POOL_NOT_FOUND' });
  });
});

describe('redeemCode dialect support', () => {
  it('fails fast on SQLite instead of retrying FOR UPDATE SKIP LOCKED into a 503', async () => {
    const strapi = {
      db: {
        // Never called: the guard must throw before any query runs.
        connection: { client: { config: { client: 'better-sqlite3' } } },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;
    const service = uniqueCouponService({ strapi });

    await expect(service.redeemCode('pool-doc')).rejects.toThrow(
      /requires PostgreSQL or MySQL 8\+/,
    );
  });
});
