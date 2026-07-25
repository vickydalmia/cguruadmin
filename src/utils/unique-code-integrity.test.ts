import { describe, expect, it, vi } from 'vitest';

const {
  CODE_GUARD_TRIGGER,
  CODE_LOOKUP_INDEX,
  LINK_GUARD_TRIGGER,
  POOL_CODE_GUARD,
  POOL_LINK_LOOKUP_INDEX,
  POOL_LINK_TABLE,
  POSTGRES_LOOKUP_INDEXES,
  chooseDuplicateKeeper,
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
});

type HarnessOptions = {
  existingIndexes?: string[];
  guardsExist?: boolean;
  missingLinkTable?: boolean;
};

function createPostgresHarness({
  existingIndexes = [],
  guardsExist = false,
  missingLinkTable = false,
}: HarnessOptions = {}) {
  const tableQueries: string[] = [];
  const rawStatements: string[] = [];

  const builder = (table: string) => {
    const chain: any = {
      join: () => chain,
      select: () => chain,
      where: () => chain,
      whereNotNull: () => chain,
      whereIn: () => chain,
      groupBy: () => chain,
      havingRaw: () => chain,
      count: () => chain,
      sum: () => chain,
      update: () => chain,
      delete: () => chain,
      then: (resolve: any, reject: any) =>
        Promise.resolve([]).then(resolve, reject),
    };
    tableQueries.push(table);
    return chain;
  };

  const knex: any = (table: string) => builder(table);
  knex.client = { config: { client: 'pg' } };
  knex.schema = {
    hasTable: async (table: string) =>
      !(missingLinkTable && table === POOL_LINK_TABLE),
  };
  knex.raw = (sql: string) => {
    rawStatements.push(sql);
    if (sql.includes('FROM pg_trigger')) {
      return Promise.resolve({
        rows: [{ count: guardsExist ? 2 : 0 }],
      });
    }
    if (sql.includes('FROM pg_indexes')) {
      return Promise.resolve({
        rows: existingIndexes.map((indexname) => ({ indexname })),
      });
    }
    return Promise.resolve({ rows: [] });
  };

  return { knex, tableQueries, rawStatements };
}

describe('reconcileUniqueCodeIntegrity Strapi relation schema', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn() });

  it('waits for schema sync when the Strapi link table does not exist yet', async () => {
    const { knex, rawStatements } = createPostgresHarness({
      missingLinkTable: true,
    });
    const log = logger();

    await expect(reconcileUniqueCodeIntegrity(knex, log)).resolves.toEqual({
      attempted: false,
      removed: 0,
      guardCreated: false,
    });
    expect(rawStatements).toEqual([]);
    expect(log.info).toHaveBeenCalled();
  });

  it('skips the duplicate scan when both PostgreSQL guards already exist', async () => {
    const { knex, tableQueries, rawStatements } = createPostgresHarness({
      guardsExist: true,
    });

    await expect(reconcileUniqueCodeIntegrity(knex, logger())).resolves.toEqual({
      attempted: true,
      removed: 0,
      guardCreated: false,
    });
    expect(tableQueries).toEqual([]);
    expect(rawStatements.join('\n')).toContain(CODE_LOOKUP_INDEX);
    expect(rawStatements.join('\n')).toContain(POOL_LINK_LOOKUP_INDEX);
  });

  it('does not issue index DDL when both lookup indexes already exist', async () => {
    const { knex, rawStatements } = createPostgresHarness({
      existingIndexes: POSTGRES_LOOKUP_INDEXES.map(
        (index: { name: string }) => index.name,
      ),
      guardsExist: true,
    });

    await expect(reconcileUniqueCodeIntegrity(knex, logger())).resolves.toEqual({
      attempted: true,
      removed: 0,
      guardCreated: false,
    });
    expect(
      rawStatements.filter((sql) => sql.startsWith('CREATE INDEX')),
    ).toEqual([]);
  });

  it('deduplicates through the Strapi link table and installs both guards', async () => {
    const { knex, tableQueries, rawStatements } = createPostgresHarness();

    await expect(reconcileUniqueCodeIntegrity(knex, logger())).resolves.toEqual({
      attempted: true,
      removed: 0,
      guardCreated: true,
    });

    expect(tableQueries[0]).toBe(`${POOL_LINK_TABLE} as pool_link`);
    expect(rawStatements.join('\n')).toContain(
      `NEW."unique_coupon_pool_id"`,
    );
    expect(rawStatements.join('\n')).toContain(POOL_CODE_GUARD);
    expect(rawStatements.join('\n')).toContain(LINK_GUARD_TRIGGER);
    expect(rawStatements.join('\n')).toContain(CODE_GUARD_TRIGGER);
    expect(rawStatements.join('\n')).toContain(CODE_LOOKUP_INDEX);
    expect(rawStatements.join('\n')).toContain(POOL_LINK_LOOKUP_INDEX);
    expect(rawStatements.join('\n')).not.toContain(
      'ON "unique_codes" ("pool_id", "code")',
    );
  });
});
