import { describe, expect, it, vi } from 'vitest';

const {
  POOL_CODE_INDEX,
  chooseDuplicateKeeper,
  indexDefinitionIsExpected,
  reconcileUniqueCodeIntegrity,
} = require('../../database/unique-code-integrity.js');

describe('unique-code integrity migration', () => {
  it('keeps the lowest id when every duplicate is unused', () => {
    expect(
      chooseDuplicateKeeper([
        { id: 9, is_used: false, used_at: null },
        { id: 3, is_used: false, used_at: null },
      ]),
    ).toMatchObject({ id: 3 });
  });

  it('keeps a used row so migration cannot make a redeemed code available again', () => {
    expect(
      chooseDuplicateKeeper([
        { id: 1, is_used: false, used_at: null },
        { id: 8, is_used: true, used_at: '2026-07-20T00:00:00.000Z' },
      ]),
    ).toMatchObject({ id: 8 });
  });

  it('uses earliest redemption and then lowest id deterministically', () => {
    const rows = [
      { id: 8, is_used: true, used_at: '2026-07-21T00:00:00.000Z' },
      { id: 7, is_used: true, used_at: '2026-07-20T00:00:00.000Z' },
      { id: 2, is_used: true, used_at: '2026-07-20T00:00:00.000Z' },
    ];
    expect(chooseDuplicateKeeper(rows)).toMatchObject({ id: 2 });
  });

  it('uses the lowest id when used rows have no redemption timestamp', () => {
    expect(
      chooseDuplicateKeeper([
        { id: 8, is_used: true, used_at: null },
        { id: 2, is_used: true, used_at: null },
      ]),
    ).toMatchObject({ id: 2 });
  });

  it('prefers a dated redemption over a used row with missing history', () => {
    expect(
      chooseDuplicateKeeper([
        { id: 1, is_used: true, used_at: null },
        { id: 8, is_used: true, used_at: '2026-07-20T00:00:00.000Z' },
      ]),
    ).toMatchObject({ id: 8 });
  });

  it('accepts only the exact SQLite composite unique-index shape', () => {
    const sqlite = { client: { config: { client: 'better-sqlite3' } } };

    expect(
      indexDefinitionIsExpected(sqlite, {
        unique: true,
        columns: ['pool_id', 'code'],
      }),
    ).toBe(true);
    expect(
      indexDefinitionIsExpected(sqlite, {
        unique: true,
        columns: ['code', 'pool_id'],
      }),
    ).toBe(false);
    expect(
      indexDefinitionIsExpected(sqlite, {
        unique: false,
        columns: ['pool_id', 'code'],
      }),
    ).toBe(false);
  });
});

// Minimal SQLite-flavoured knex stand-in. Table queries record which tables
// were touched and resolve empty (no duplicate groups, no pool counts);
// knex.raw serves the PRAGMA index lookups and records DDL.
function makeSqliteKnex({ indexExists, indexUnique = 1 }: { indexExists: boolean; indexUnique?: 0 | 1 }) {
  const tableQueries: string[] = [];
  const rawStatements: string[] = [];

  const builder = () => {
    const chain: any = {};
    for (const method of [
      'select', 'whereNotNull', 'groupBy', 'havingRaw',
      'where', 'whereIn', 'update', 'count', 'sum', 'delete',
    ]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: any, reject: any) => Promise.resolve([]).then(resolve, reject);
    return chain;
  };

  const knex: any = (table: string) => {
    tableQueries.push(table);
    return builder();
  };
  knex.client = { config: { client: 'better-sqlite3' } };
  knex.schema = { hasTable: async () => true };
  knex.raw = (sql: string) => {
    rawStatements.push(sql);
    if (sql.includes('index_list')) {
      return Promise.resolve(
        indexExists ? [{ name: POOL_CODE_INDEX, unique: indexUnique }] : [],
      );
    }
    if (sql.includes('index_info')) {
      return Promise.resolve([
        { seqno: 0, name: 'pool_id' },
        { seqno: 1, name: 'code' },
      ]);
    }
    return Promise.resolve([]);
  };

  return { knex, tableQueries, rawStatements };
}

describe('reconcileUniqueCodeIntegrity boot ordering', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn() });

  it('skips the duplicate scan entirely when the unique index already exists', async () => {
    const { knex, tableQueries, rawStatements } = makeSqliteKnex({ indexExists: true });
    const log = logger();

    const result = await reconcileUniqueCodeIntegrity(knex, log);

    expect(result).toEqual({ attempted: true, removed: 0, indexCreated: false });
    // No table query at all: neither the GROUP BY duplicate scan nor the pool
    // recount runs on a healthy boot.
    expect(tableQueries).toEqual([]);
    expect(rawStatements.some((sql) => sql.includes('CREATE UNIQUE INDEX'))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('still dedupes BEFORE creating the index when it is missing', async () => {
    const { knex, tableQueries, rawStatements } = makeSqliteKnex({ indexExists: false });

    const result = await reconcileUniqueCodeIntegrity(knex, logger());

    expect(result).toEqual({ attempted: true, removed: 0, indexCreated: true });
    // The duplicate scan ran (a unique index cannot be created over a table
    // that still holds duplicates), then the index DDL, then the recount.
    expect(tableQueries[0]).toBe('unique_codes');
    expect(rawStatements.some((sql) => sql.includes('CREATE UNIQUE INDEX'))).toBe(true);
    expect(tableQueries).toContain('unique_coupon_pools');
  });

  it('still refuses a same-named index of the wrong shape', async () => {
    const { knex } = makeSqliteKnex({ indexExists: true, indexUnique: 0 });

    await expect(reconcileUniqueCodeIntegrity(knex, logger())).rejects.toThrow(
      /not the expected unique/,
    );
  });
});
