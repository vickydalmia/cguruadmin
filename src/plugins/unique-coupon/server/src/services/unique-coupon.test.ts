import { describe, expect, it, vi } from 'vitest';

import uniqueCouponService from './unique-coupon';

type RawCall = { sql: string; bindings: any[] };

type HarnessOptions = {
  client?: string;
  poolRow?: { id: number; name?: string; document_id?: string } | null;
  existingCodes?: string[];
  /**
   * Codes the atomic claim statement hands back, one per call. `null` models a
   * claim that matched no row — either the pool is dry or every free code was
   * momentarily locked by a concurrent claimer.
   */
  claimResults?: Array<string | null>;
  /** Whether any unused code remains, as the availability probe would report. */
  hasUnused?: boolean;
  /** Code already claimed by the activation id under test, if any. */
  replayCode?: string | null;
  /**
   * Code the replay lookup starts returning only once a claim has failed —
   * models the loser of a same-activation race reading back the winner's code.
   */
  replayCodeAfterConflict?: string | null;
  claimError?: { code?: string } | null;
  stats?: { total: string; used: string };
};

function createHarness({
  client = 'pg',
  poolRow = { id: 7, name: 'Summer', document_id: 'pool-doc' },
  existingCodes = [],
  claimResults = [],
  hasUnused = false,
  replayCode = null,
  replayCodeAfterConflict = null,
  claimError = null,
  stats = { total: '0', used: '0' },
}: HarnessOptions = {}) {
  let insertedId = 100;
  let claimAttempts = 0;
  let claimErrorsThrown = 0;
  const calls = {
    tables: [] as string[],
    joins: [] as string[],
    forUpdate: 0,
    raw: [] as RawCall[],
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
      whereNull: () => chain,
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
          // Redemption no longer goes through the query builder; the only
          // remaining `.first()` on this join is getPoolStats.
          result = state.first ? stats : existingCodes.map((code) => ({ code }));
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

  const raw = vi.fn((sql: string, bindings: any[] = []) => {
    calls.raw.push({ sql, bindings });

    if (sql.includes('RETURNING code')) {
      claimAttempts += 1;
      if (claimError && claimErrorsThrown < 1) {
        claimErrorsThrown += 1;
        return Promise.reject(Object.assign(new Error('claim'), claimError));
      }
      const code = claimResults[claimAttempts - 1] ?? null;
      return Promise.resolve({ rows: code ? [{ code }] : [] });
    }
    if (sql.includes('uc.claim_token = ?')) {
      const code =
        claimErrorsThrown > 0 ? (replayCodeAfterConflict ?? replayCode) : replayCode;
      return Promise.resolve({ rows: code ? [{ code }] : [] });
    }
    // Must precede the availability branch: the guarded exhaustion UPDATE also
    // contains a `SELECT 1`, inside its NOT EXISTS re-check.
    if (sql.includes('SET exhausted_at')) {
      return Promise.resolve({ rowCount: 1, rows: [] });
    }
    if (sql.includes('SELECT 1')) {
      return Promise.resolve({ rows: hasUnused ? [{ '?column?': 1 }] : [] });
    }
    if (sql.includes('COUNT(*)')) return stats;
    return {};
  });

  const trx: any = Object.assign(
    (table: string) => makeBuilder(table),
    {
      client: { config: { client } },
      raw,
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

describe('redeemCode', () => {
  const claimSql = (harness: ReturnType<typeof createHarness>) =>
    harness.calls.raw.find((call) => call.sql.includes('RETURNING code'));

  it('claims one code with a single atomic statement', async () => {
    const harness = createHarness({ claimResults: ['PROMO-22'] });

    await expect(harness.service.redeemCode('pool-doc')).resolves.toEqual({
      success: true,
      code: 'PROMO-22',
    });

    const claim = claimSql(harness);
    expect(claim?.sql).toContain('FOR UPDATE SKIP LOCKED');
    // Re-checked on the UPDATE itself: this, not a mutex, is what stops two
    // visitors being handed the same code.
    expect(claim?.sql).toMatch(/\)\s*\n?\s*AND is_used = false/u);
    expect(claim?.bindings[2]).toBe(7);
  });

  it('takes no lock on the pool row and never writes the pool counter', async () => {
    const harness = createHarness({ claimResults: ['PROMO-22'] });

    await harness.service.redeemCode('pool-doc');

    // Both would reserialize every concurrent claimer on one row.
    expect(harness.calls.forUpdate).toBe(0);
    expect(harness.calls.increments).toEqual([]);
  });

  it('draws a single EXISTS, never an OR-of-EXISTS', async () => {
    // The wide OR form inflates planner cost enough to trip PG JIT — the
    // failure mode that took down public search.
    const harness = createHarness({ claimResults: ['PROMO-22'] });

    await harness.service.redeemCode('pool-doc');

    const claim = claimSql(harness);
    expect(claim?.sql.match(/EXISTS/gu)).toHaveLength(1);
    expect(claim?.sql).not.toContain(' OR ');
  });

  it('reports NO_CODES_AVAILABLE only when no unused code remains', async () => {
    const harness = createHarness({ claimResults: [null], hasUnused: false });

    await expect(harness.service.redeemCode('pool-doc')).resolves.toMatchObject({
      success: false,
      error: 'NO_CODES_AVAILABLE',
    });
    expect(harness.calls.increments).toEqual([]);
  });

  it('retries instead of reporting exhaustion when free codes are merely locked', async () => {
    // A burst of concurrent clicks can make every free code momentarily
    // unavailable to SKIP LOCKED. That is not an empty pool.
    const harness = createHarness({
      claimResults: [null, 'PROMO-99'],
      hasUnused: true,
    });

    await expect(harness.service.redeemCode('pool-doc')).resolves.toEqual({
      success: true,
      code: 'PROMO-99',
    });
    expect(
      harness.calls.raw.filter((call) => call.sql.includes('RETURNING code')),
    ).toHaveLength(2);
  });

  it('returns POOL_NOT_FOUND without attempting a claim', async () => {
    const harness = createHarness({ poolRow: null });

    await expect(harness.service.redeemCode('missing')).resolves.toMatchObject({
      success: false,
      error: 'POOL_NOT_FOUND',
    });
    expect(claimSql(harness)).toBeUndefined();
  });

  it('fails fast outside PostgreSQL', async () => {
    const harness = createHarness({ client: 'better-sqlite3' });

    await expect(harness.service.redeemCode('pool-doc')).rejects.toThrow(
      /require PostgreSQL/,
    );
  });
});

describe('redeemCode idempotency per activation', () => {
  const activationId = 'b9d2c1a4e5f64738a1b2c3d4e5f60718';

  it('replays the code this activation already claimed instead of burning another', async () => {
    const harness = createHarness({
      replayCode: 'PROMO-FIRST',
      claimResults: ['PROMO-SECOND'],
    });

    await expect(
      harness.service.redeemCode('pool-doc', { activationId }),
    ).resolves.toEqual({ success: true, code: 'PROMO-FIRST' });
    expect(
      harness.calls.raw.filter((call) => call.sql.includes('RETURNING code')),
    ).toEqual([]);
  });

  it('scopes the replay to the pool and to a recent claim', async () => {
    const harness = createHarness({ replayCode: 'PROMO-FIRST' });

    await harness.service.redeemCode('pool-doc', { activationId });

    const replay = harness.calls.raw.find((call) =>
      call.sql.includes('uc.claim_token = ?'),
    );
    expect(replay?.bindings[0]).toBe(activationId);
    expect(replay?.bindings[1]).toBe(7);
    // A leaked activation id must not stay a read capability for a live code.
    expect(replay?.bindings[2]).toBeInstanceOf(Date);
    expect(replay?.sql).toContain('uc.used_at > ?');
  });

  it('stamps the activation on the claimed row', async () => {
    const harness = createHarness({ claimResults: ['PROMO-NEW'] });

    await harness.service.redeemCode('pool-doc', { activationId });

    const claim = harness.calls.raw.find((call) =>
      call.sql.includes('RETURNING code'),
    );
    expect(claim?.bindings[1]).toBe(activationId);
  });

  it('replays the winner when two requests race the same activation', async () => {
    // The partial unique index on claim_token rejects the loser; both callers
    // should still receive the one code that activation claimed.
    const harness = createHarness({
      claimError: { code: '23505' },
      replayCodeAfterConflict: 'PROMO-WINNER',
      claimResults: [],
    });

    await expect(
      harness.service.redeemCode('pool-doc', { activationId }),
    ).resolves.toEqual({ success: true, code: 'PROMO-WINNER' });
  });

  it('claims without a token when no activation id is supplied', async () => {
    const harness = createHarness({ claimResults: ['PROMO-ANON'] });

    await expect(harness.service.redeemCode('pool-doc')).resolves.toEqual({
      success: true,
      code: 'PROMO-ANON',
    });
    expect(
      harness.calls.raw.some((call) => call.sql.includes('uc.claim_token = ?')),
    ).toBe(false);
    expect(claimSqlBindings(harness)?.[1]).toBeNull();
  });

  function claimSqlBindings(harness: ReturnType<typeof createHarness>) {
    return harness.calls.raw.find((call) => call.sql.includes('RETURNING code'))
      ?.bindings;
  }
});

describe('redeemCode exhaustion stamp', () => {
  const stampCall = (harness: ReturnType<typeof createHarness>) =>
    harness.calls.raw.find((call) => call.sql.includes('SET exhausted_at'));

  it('re-checks emptiness inside the UPDATE so a restock is never clobbered', () => {
    // The probe and the stamp are separate statements, and importCodes clears
    // exhausted_at inside a transaction holding the pool row lock. Without the
    // NOT EXISTS re-check, an import committing between the two would have its
    // restock overwritten and the scheduler would expire live offers.
    const harness = createHarness({ claimResults: [null], hasUnused: false });

    return harness.service.redeemCode('pool-doc').then(() => {
      const stamp = stampCall(harness);
      expect(stamp?.sql).toContain('exhausted_at IS NULL');
      expect(stamp?.sql).toContain('NOT EXISTS');
      expect(stamp?.sql).toContain('uc.is_used = false');
      // Bound twice: once for the row, once for the NOT EXISTS re-check.
      expect(stamp?.bindings.slice(1)).toEqual([7, 7]);
    });
  });

  it('does not stamp while codes remain', async () => {
    const harness = createHarness({
      claimResults: [null, 'PROMO-9'],
      hasUnused: true,
    });

    await harness.service.redeemCode('pool-doc');

    expect(stampCall(harness)).toBeUndefined();
  });
});

describe('redeemCode with a claim token past its replay window', () => {
  const activationId = 'b9d2c1a4e5f64738a1b2c3d4e5f60718';

  it('draws a fresh code instead of looping to a 503', async () => {
    // The unique index on claim_token is permanent, but replay is bounded to
    // 24h. An activation older than that can neither be replayed nor re-used,
    // so retrying with the same token burns every attempt and returns
    // MAX_RETRIES_EXCEEDED. Dropping the token is the way out.
    const harness = createHarness({
      claimError: { code: '23505' },
      replayCode: null,
      replayCodeAfterConflict: null,
      claimResults: [null, 'PROMO-FRESH'],
    });

    await expect(
      harness.service.redeemCode('pool-doc', { activationId }),
    ).resolves.toEqual({ success: true, code: 'PROMO-FRESH' });
  });

  it('retries without the token once it is known to be stale', async () => {
    const harness = createHarness({
      claimError: { code: '23505' },
      replayCode: null,
      replayCodeAfterConflict: null,
      claimResults: [null, 'PROMO-FRESH'],
    });

    await harness.service.redeemCode('pool-doc', { activationId });

    const claims = harness.calls.raw.filter((call) =>
      call.sql.includes('RETURNING code'),
    );
    // First attempt carries the activation; the retry after the conflict does
    // not, so this draw is simply no longer idempotent.
    expect(claims[0]?.bindings[1]).toBe(activationId);
    expect(claims.at(-1)?.bindings[1]).toBeNull();
  });
});
