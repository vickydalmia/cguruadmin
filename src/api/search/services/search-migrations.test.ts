import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXPECTED_SEARCH_INDEXES } from "./search";

const oldMigration = require("../../../../database/migrations/2026.07.12T01.00.00.add-public-search-indexes.js");
const reconcileMigration = require("../../../../database/migrations/2026.07.19T00.00.00.add-search-rank-indexes.js");
const {
  EXPECTED_SEARCH_INDEX_TARGETS,
  PUBLIC_SEARCH_INDEX_TARGETS,
  reconcileSearchIndexesAfterSchemaSync,
} = require("../../../../database/search-index-migration.js");

type RawCall = { sql: string; bindings: unknown[] };

function mockKnex(
  onDdl?: (
    sql: string,
    bindings: unknown[],
  ) => Error | { rows?: unknown[] } | undefined,
  client = "pg",
  hasTable: (table: string) => boolean = () => true,
) {
  const calls: RawCall[] = [];
  const raw = vi.fn(async (sql: string, bindings: unknown[] = []) => {
    calls.push({ sql, bindings });
    const result = onDdl?.(sql, bindings);
    if (result instanceof Error) throw result;
    if (result) return result;
    if (sql.includes("FROM pg_extension")) {
      return { rows: [{ schema_name: "extensions" }] };
    }
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: true }] };
    }
    if (sql.includes("to_regclass")) {
      const relation = String(bindings[0] ?? "");
      const table = relation.replace(/"/gu, "").split(".").at(-1) ?? "";
      return hasTable(table)
        ? { rows: [{ schema_name: "public" }] }
        : { rows: [] };
    }
    if (sql.includes("pg_get_indexdef")) return { rows: [] };
    return {};
  });
  const schema = { hasTable: vi.fn(async (table: string) => hasTable(table)) };
  const knex: any = { client: { config: { client } }, raw, schema };
  knex.transaction = vi.fn(async (callback: (transaction: any) => unknown) =>
    callback(knex),
  );
  return {
    calls,
    knex,
    raw,
    schema,
  };
}

function pgError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("search index migrations", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("keeps the runtime and migration expected-index inventories aligned", () => {
    expect(
      EXPECTED_SEARCH_INDEX_TARGETS.map(
        ([table, column]: [string, string]) =>
          `${table}_${column}_search_trgm_idx`,
      ),
    ).toEqual([...EXPECTED_SEARCH_INDEXES]);
  });

  it("runs post-schema reconciliation before search diagnostics in bootstrap", () => {
    // The require blocks live in bootstrap/db-reconciliation.ts; index.ts
    // bootstrap must invoke that runner before search initialization.
    const reconciliations = readFileSync(
      resolve(__dirname, "../../../bootstrap/db-reconciliation.ts"),
      "utf8",
    );
    expect(reconciliations).toContain("(strapi as any).dirs.app.root");
    expect(reconciliations).not.toContain(
      "require('../database/search-index-migration')",
    );
    expect(reconciliations).toContain("reconcileSearchIndexesAfterSchemaSync(");
    const source = readFileSync(
      resolve(__dirname, "../../../index.ts"),
      "utf8",
    );
    const bootstrap = source.slice(source.indexOf("async bootstrap"));
    // Presence FIRST: indexOf returns -1 when the call is missing, and
    // -1 < any found index — without this guard the ordering assertion
    // below passes vacuously if the reconciliation runner is deleted.
    expect(bootstrap).toContain("runDatabaseReconciliations(strapi)");
    expect(bootstrap).toContain("initializeSearchRuntime(strapi)");
    expect(
      bootstrap.indexOf("runDatabaseReconciliations(strapi)"),
    ).toBeLessThan(bootstrap.indexOf("initializeSearchRuntime(strapi)"));
  });

  it("skips both migrations completely outside Postgres", async () => {
    for (const migration of [oldMigration, reconcileMigration]) {
      const { knex, raw } = mockKnex(undefined, "sqlite");
      await expect(migration.up(knex)).resolves.toBeUndefined();
      expect(raw).not.toHaveBeenCalled();
    }
  });

  it("bounds optional boot DDL with transaction-local timeouts", async () => {
    for (const migration of [oldMigration, reconcileMigration]) {
      const { knex, calls } = mockKnex();
      await migration.up(knex);
      expect(calls.slice(0, 2).map(({ sql }) => sql)).toEqual([
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '30s'",
      ]);
    }
  });

  it("rolls back an expected extension denial to its nested savepoint", async () => {
    for (const migration of [oldMigration, reconcileMigration]) {
      const { knex, calls } = mockKnex((sql) => {
        if (sql.includes("FROM pg_extension")) return { rows: [] };
        return sql.startsWith("CREATE EXTENSION")
          ? pgError("permission denied to create extension", "42501")
          : undefined;
      });
      await expect(migration.up(knex)).resolves.toBeUndefined();
      expect(calls.map(({ sql }) => sql)).toEqual([
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '30s'",
        expect.stringContaining("pg_try_advisory_xact_lock"),
        expect.stringContaining("FROM pg_extension"),
        expect.stringMatching(/^SAVEPOINT search_ext_/u),
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        expect.stringMatching(/^ROLLBACK TO SAVEPOINT search_ext_/u),
        expect.stringMatching(/^RELEASE SAVEPOINT search_ext_/u),
      ]);
    }
  });

  it("creates pg_trgm only when the catalog says it is absent", async () => {
    let catalogReads = 0;
    const { knex, calls } = mockKnex((sql) => {
      if (!sql.includes("FROM pg_extension")) return undefined;
      catalogReads += 1;
      return catalogReads === 1
        ? { rows: [] }
        : { rows: [{ schema_name: "extensions" }] };
    });

    await reconcileMigration.up(knex);
    expect(
      calls.filter(({ sql }) => sql === "CREATE EXTENSION IF NOT EXISTS pg_trgm"),
    ).toHaveLength(1);
    expect(catalogReads).toBe(2);
  });

  it("stops each migration pass after its first bounded index failure", async () => {
    for (const migration of [oldMigration, reconcileMigration]) {
      const { knex, calls } = mockKnex((sql) =>
        sql.startsWith("CREATE INDEX")
          ? pgError("canceling statement due to lock timeout", "55P03")
          : undefined,
      );

      await expect(migration.up(knex)).resolves.toBeUndefined();
      const creates = calls.filter(({ sql }) => sql.startsWith("CREATE INDEX"));
      expect(creates).toHaveLength(1);
      expect(
        calls.some(({ sql }) => sql.startsWith("ROLLBACK TO SAVEPOINT")),
      ).toBe(true);
    }
  });

  it("skips migration and bootstrap reconciliation immediately when another instance owns the lock", async () => {
    const unavailableLock = (sql: string) =>
      sql.includes("pg_try_advisory_xact_lock")
        ? { rows: [{ acquired: false }] }
        : undefined;
    for (const migration of [oldMigration, reconcileMigration]) {
      const { knex, calls } = mockKnex(unavailableLock);
      await expect(migration.up(knex)).resolves.toBeUndefined();
      expect(calls.some(({ sql }) => sql.includes("FROM pg_extension"))).toBe(
        false,
      );
      expect(calls.some(({ sql }) => sql.startsWith("CREATE INDEX"))).toBe(
        false,
      );
    }

    const { knex, calls } = mockKnex(unavailableLock);
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await expect(
      reconcileSearchIndexesAfterSchemaSync(knex, logger),
    ).resolves.toMatchObject({ attempted: true, reconciled: 0 });
    expect(calls.some(({ sql }) => sql.includes("FROM pg_extension"))).toBe(
      false,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping this pass without waiting"),
    );
  });

  it("the later migration reconciles the complete expected index set", async () => {
    const { knex, calls } = mockKnex();
    await reconcileMigration.up(knex);
    const indexes = calls
      .filter(({ sql }) => sql.startsWith("CREATE INDEX"))
      .map(({ bindings }) => bindings[0]);
    expect(indexes).toEqual([...EXPECTED_SEARCH_INDEXES]);
    for (const create of calls.filter(({ sql }) => sql.startsWith("CREATE INDEX"))) {
      expect(create.sql).toContain(
        "translate(??, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')",
      );
      expect(create.sql).toContain("??.gin_trgm_ops");
      expect(create.sql).toContain("ON ??.??");
      expect(create.bindings.slice(1, 3)).toEqual(["public", expect.any(String)]);
      expect(create.bindings.at(-1)).toBe("extensions");
    }
  });

  it("atomically replaces a same-name index with the wrong definition", async () => {
    const badIndex = EXPECTED_SEARCH_INDEXES[0];
    const { knex, calls } = mockKnex((sql, bindings) => {
      if (sql.includes("pg_get_indexdef") && bindings[1] === badIndex) {
        return {
          rows: [
            {
              table_schema: "public",
              table_name: "stores",
              access_method: "btree",
              key_count: 1,
              expression: "lower(name)",
              opclass_name: "text_ops",
              opclass_schema: "pg_catalog",
              predicate: null,
              indisvalid: false,
              indisready: false,
            },
          ],
        };
      }
      return undefined;
    });

    await reconcileMigration.up(knex);

    const dropPosition = calls.findIndex(
      ({ sql, bindings }) =>
        sql.startsWith("DROP INDEX") && bindings[1] === badIndex,
    );
    const createPosition = calls.findIndex(
      ({ sql, bindings }) =>
        sql.startsWith("CREATE INDEX") && bindings[0] === badIndex,
    );
    expect(dropPosition).toBeGreaterThan(-1);
    expect(createPosition).toBeGreaterThan(dropPosition);
    expect(calls[dropPosition - 1]?.sql).toMatch(/^SAVEPOINT search_idx_/u);
    expect(calls[createPosition + 1]?.sql).toMatch(/^RELEASE SAVEPOINT/u);
    expect(calls.some(({ sql }) => sql.includes("CONCURRENTLY"))).toBe(false);
  });

  it("rolls back the invalid-index drop when replacement creation times out", async () => {
    const badIndex = EXPECTED_SEARCH_INDEXES[0];
    const timeout = pgError("canceling statement due to lock timeout", "55P03");
    const { knex, calls } = mockKnex((sql, bindings) => {
      if (sql.includes("pg_get_indexdef") && bindings[1] === badIndex) {
        return {
          rows: [
            {
              table_schema: "public",
              table_name: "stores",
              access_method: "btree",
              key_count: 1,
              expression: "lower(name)",
              opclass_name: "text_ops",
              opclass_schema: "pg_catalog",
              predicate: null,
              indisvalid: true,
              indisready: true,
            },
          ],
        };
      }
      if (sql.startsWith("CREATE INDEX") && bindings[0] === badIndex) {
        return timeout;
      }
      return undefined;
    });

    await expect(reconcileMigration.up(knex)).resolves.toBeUndefined();
    const dropPosition = calls.findIndex(
      ({ sql, bindings }) =>
        sql.startsWith("DROP INDEX") && bindings[1] === badIndex,
    );
    expect(dropPosition).toBeGreaterThan(-1);
    expect(
      calls.slice(dropPosition).some(({ sql }) =>
        sql.startsWith("ROLLBACK TO SAVEPOINT"),
      ),
    ).toBe(true);
  });

  it("uses the discovered pg_trgm schema even when it is outside search_path", async () => {
    const { knex, calls } = mockKnex();
    await reconcileMigration.up(knex);
    expect(calls.some(({ sql }) => sql.includes("FROM pg_extension"))).toBe(true);
    expect(
      calls
        .filter(({ sql }) => sql.startsWith("CREATE INDEX"))
        .every(({ bindings }) => bindings.at(-1) === "extensions"),
    ).toBe(true);
  });

  it("handles only the expected missing gin_trgm_ops error", async () => {
    const missingOpclass = pgError(
      'operator class "extensions.gin_trgm_ops" does not exist for access method "gin"',
      "42704",
    );
    const expected = mockKnex((sql) =>
      sql.startsWith("CREATE INDEX") ? missingOpclass : undefined,
    );
    await expect(reconcileMigration.up(expected.knex)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();

    const otherUndefinedObject = pgError('type "missing_type" does not exist', "42704");
    const unexpected = mockKnex((sql) =>
      sql.startsWith("CREATE INDEX") ? otherUndefinedObject : undefined,
    );
    await expect(reconcileMigration.up(unexpected.knex)).rejects.toBe(
      otherUndefinedObject,
    );
  });

  it("retries a fresh schema automatically after Strapi schema sync", async () => {
    // Strapi 5 runs database/migrations BEFORE schema sync creates the
    // content tables: a fresh database must skip the index DDL instead of
    // aborting boot with 42P01 (undefined_table).
    let tablesExist = false;
    const { knex, calls } = mockKnex(undefined, "pg", () => tablesExist);

    await expect(reconcileMigration.up(knex)).resolves.toBeUndefined();
    expect(calls.some(({ sql }) => sql.startsWith("CREATE INDEX"))).toBe(false);
    expect(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])).toContain(
      "bootstrap retries automatically",
    );

    tablesExist = true;
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    await expect(
      reconcileSearchIndexesAfterSchemaSync(knex, logger),
    ).resolves.toMatchObject({ attempted: true, reconciled: 11 });
    expect(knex.transaction).toHaveBeenCalledTimes(1);
    expect(
      calls.filter(({ sql }) => sql.startsWith("CREATE INDEX")),
    ).toHaveLength(EXPECTED_SEARCH_INDEX_TARGETS.length);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("checks healthy indexes on every bootstrap without issuing index DDL", async () => {
    const definitions = new Map(
      EXPECTED_SEARCH_INDEX_TARGETS.map(([table, column]: [string, string]) => [
        `${table}_${column}_search_trgm_idx`,
        { table, column },
      ]),
    );
    const { knex, calls } = mockKnex((sql, bindings) => {
      if (!sql.includes("pg_get_indexdef")) return undefined;
      const definition = definitions.get(String(bindings[1]));
      if (!definition) return { rows: [] };
      return {
        rows: [
          {
            table_schema: "public",
            table_name: definition.table,
            access_method: "gin",
            key_count: 1,
            expression:
              `translate((${definition.column})::text, ` +
              `'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, ` +
              `'abcdefghijklmnopqrstuvwxyz'::text)`,
            opclass_name: "gin_trgm_ops",
            opclass_schema: "extensions",
            predicate: null,
            indisvalid: true,
            indisready: true,
          },
        ],
      };
    });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    await expect(
      reconcileSearchIndexesAfterSchemaSync(knex, logger),
    ).resolves.toMatchObject({ attempted: true, reconciled: 0 });
    expect(calls.filter(({ sql }) => sql.startsWith("CREATE INDEX"))).toEqual(
      [],
    );
    expect(calls.filter(({ sql }) => sql.startsWith("DROP INDEX"))).toEqual([]);
    expect(
      calls.filter(({ sql }) => sql.startsWith("CREATE EXTENSION")),
    ).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps bootstrap available on extension denial and bounded index locks", async () => {
    let firstIndex = true;
    const { knex } = mockKnex((sql) => {
      if (sql.startsWith("CREATE INDEX") && firstIndex) {
        firstIndex = false;
        return pgError("canceling statement due to lock timeout", "55P03");
      }
      return undefined;
    });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await expect(
      reconcileSearchIndexesAfterSchemaSync(knex, logger),
    ).resolves.toMatchObject({ attempted: true, reconciled: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("automatic reconciliation will retry"),
    );
    expect(logger.error).not.toHaveBeenCalled();

    const denied = mockKnex((sql) => {
      if (sql.includes("FROM pg_extension")) return { rows: [] };
      return sql.startsWith("CREATE EXTENSION")
        ? pgError("permission denied to create extension", "42501")
        : undefined;
    });
    await expect(
      reconcileSearchIndexesAfterSchemaSync(denied.knex, logger),
    ).resolves.toMatchObject({ attempted: true, reconciled: 0 });
  });

  it("rolls back and throws unexpected schema errors in both migrations", async () => {
    for (const migration of [oldMigration, reconcileMigration]) {
      const schemaError = pgError('column "name" does not exist', "42703");
      const { knex, calls } = mockKnex((sql) =>
        sql.startsWith("CREATE INDEX") ? schemaError : undefined,
      );
      await expect(migration.up(knex)).rejects.toBe(schemaError);
      expect(calls.some(({ sql }) => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(
        true,
      );
      expect(console.warn).not.toHaveBeenCalled();
    }
  });
});
