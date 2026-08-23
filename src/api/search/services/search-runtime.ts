// Search RUNTIME & DIAGNOSTICS: dialect-pinned mode selection, index
// health checks, and the per-mode dispatch helper. One of the modules split
// out of the search service (see ./search.ts).
import type { Core } from "@strapi/strapi";
import { oneString } from "./search-request";
import {
  asciiFold,
  entityCountQuery,
  entityRankedQuery,
  isPostgresClient,
  NO_MATCH_TIER,
  offerCountQuery,
  offerRankedQuery,
  RELATION_TIER_SHIFT,
  VARIANT_TIER_SHIFT,
  type OfferKind,
  type SearchNeedles,
  type SqlQuery,
} from "./search-sql";

const EXPECTED_SEARCH_INDEX_DEFINITIONS = [
  { name: "stores_name_search_trgm_idx", table: "stores", column: "name" },
  { name: "brands_name_search_trgm_idx", table: "brands", column: "name" },
  { name: "categories_name_search_trgm_idx", table: "categories", column: "name" },
  { name: "banks_name_search_trgm_idx", table: "banks", column: "name" },
  { name: "coupons_title_search_trgm_idx", table: "coupons", column: "title" },
  { name: "deals_title_search_trgm_idx", table: "deals", column: "title" },
  { name: "stores_slug_search_trgm_idx", table: "stores", column: "slug" },
  { name: "brands_slug_search_trgm_idx", table: "brands", column: "slug" },
  { name: "categories_slug_search_trgm_idx", table: "categories", column: "slug" },
  { name: "banks_slug_search_trgm_idx", table: "banks", column: "slug" },
  { name: "coupons_code_search_trgm_idx", table: "coupons", column: "code" },
] as const;

export const EXPECTED_SEARCH_INDEXES = EXPECTED_SEARCH_INDEX_DEFINITIONS.map(
  ({ name }) => name,
);

export function rankedConnection(strapi: Core.Strapi) {
  const connection = (strapi.db as any)?.connection;
  return connection && isPostgresClient(connection?.client?.config?.client)
    ? connection
    : null;
}

// ── Bootstrap mode selection and diagnostics ────────────────────────────
// The request path never probes capabilities or changes mode. Strapi's
// bootstrap fixes the mode from the configured database dialect alone.
// pg_trgm and its expected indexes are observed separately because they are
// performance aids, never correctness prerequisites.
export type SearchMode = "postgres-sql" | "query-engine";

export type InvalidExpectedIndex = { name: string; reason: string };

export type SearchRuntimeStatus = {
  mode: SearchMode;
  pgTrgmAvailable: boolean;
  missingExpectedIndexes: string[];
  invalidExpectedIndexes: InvalidExpectedIndex[];
};

type SearchRuntime = { status: SearchRuntimeStatus; initialized: boolean };
let searchRuntimes = new WeakMap<object, SearchRuntime>();

export function configureSearchRuntime(
  strapi: Core.Strapi,
): SearchRuntimeStatus {
  const mode: SearchMode = rankedConnection(strapi)
    ? "postgres-sql"
    : "query-engine";
  const status: SearchRuntimeStatus = {
    mode,
    pgTrgmAvailable: false,
    missingExpectedIndexes:
      mode === "postgres-sql" ? [...EXPECTED_SEARCH_INDEXES] : [],
    invalidExpectedIndexes: [],
  };
  searchRuntimes.set(strapi as object, { status, initialized: false });
  return {
    ...status,
    missingExpectedIndexes: [...status.missingExpectedIndexes],
    invalidExpectedIndexes: [],
  };
}

function runtimeFor(strapi: Core.Strapi): SearchRuntime {
  const runtime = searchRuntimes.get(strapi as object);
  if (!runtime) {
    throw new Error(
      "Search runtime was not initialized during Strapi bootstrap",
    );
  }
  return runtime;
}

function resultRows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function configuredDatabaseSchema(
  strapi: Core.Strapi,
  connection: any,
): string | null {
  const configured =
    (strapi as any)?.config?.get?.("database.connection.connection.schema") ??
    connection?.client?.config?.connection?.schema;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : null;
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

async function resolveSearchTableSchema(
  strapi: Core.Strapi,
  connection: any,
): Promise<string | null> {
  const configuredSchema = configuredDatabaseSchema(strapi, connection);
  const tables = Array.from(
    new Set(EXPECTED_SEARCH_INDEX_DEFINITIONS.map(({ table }) => table)),
  );
  const relationNames = tables.map((table) =>
    configuredSchema
      ? `${quotedIdentifier(configuredSchema)}.${quotedIdentifier(table)}`
      : quotedIdentifier(table),
  );
  const result = await connection.raw(
    "WITH candidates(relation_name) AS (SELECT unnest(?::text[])) " +
      "SELECT table_namespace.nspname AS schema_name " +
      "FROM candidates " +
      "JOIN pg_class table_class " +
      "ON table_class.oid = to_regclass(candidates.relation_name) " +
      "JOIN pg_namespace table_namespace " +
      "ON table_namespace.oid = table_class.relnamespace " +
      "WHERE table_class.relkind IN ('r', 'p') " +
      "GROUP BY table_namespace.nspname " +
      "HAVING count(*) = ? " +
      "LIMIT 1",
    [relationNames, tables.length],
  );
  return oneString(resultRows(result)[0]?.schema_name);
}

function logSearchDiagnosticProblem(strapi: Core.Strapi, message: string) {
  const log = (strapi as any).log;
  if (process.env.NODE_ENV === "production") log?.error?.(message);
  else log?.warn?.(message);
}

function canonicalIndexExpression(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, "")
    .replace(/::(?:text|charactervarying)/giu, "")
    .replace(/"/gu, "")
    .replace(/\(([a-z_][a-z0-9_$]*)\)/giu, "$1")
    .replace(/^translate(?=\()/iu, "translate");
}

function expectedIndexExpression(column: string): string {
  return (
    `translate(${column},` +
    `'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`
  );
}

function invalidIndexReason(
  row: any,
  expected: (typeof EXPECTED_SEARCH_INDEX_DEFINITIONS)[number],
  pgTrgmSchema: string | null,
): string | null {
  const reasons: string[] = [];
  const expectedSchema = String(row?.expected_schema ?? "");
  if (
    String(row?.table_schema ?? "") !== expectedSchema ||
    String(row?.table_name ?? "") !== expected.table
  ) {
    reasons.push(`wrong table; expected ${expectedSchema}.${expected.table}`);
  }
  if (String(row?.access_method ?? "") !== "gin") {
    reasons.push("access method is not GIN");
  }
  if (Number(row?.key_count) !== 1) {
    reasons.push("expected exactly one indexed expression");
  }
  if (
    canonicalIndexExpression(row?.expression) !==
    expectedIndexExpression(expected.column)
  ) {
    reasons.push(
      `wrong expression; expected deterministic ASCII fold of ${expected.column}`,
    );
  }
  if (String(row?.opclass_name ?? "") !== "gin_trgm_ops") {
    reasons.push("operator class is not gin_trgm_ops");
  } else if (!pgTrgmSchema) {
    reasons.push("pg_trgm schema is unavailable; operator class is unverifiable");
  } else if (String(row?.opclass_schema ?? "") !== pgTrgmSchema) {
    reasons.push(`gin_trgm_ops is not from ${pgTrgmSchema}`);
  }
  if (row?.predicate != null) reasons.push("index is partial");
  if (row?.indisvalid !== true) reasons.push("index is not valid");
  if (row?.indisready !== true) reasons.push("index is not ready");
  return reasons.length > 0 ? reasons.join("; ") : null;
}

export async function initializeSearchRuntime(
  strapi: Core.Strapi,
): Promise<SearchRuntimeStatus> {
  const existing = searchRuntimes.get(strapi as object);
  if (existing?.initialized) return searchRuntimeStatus(strapi);
  configureSearchRuntime(strapi);
  const runtime = runtimeFor(strapi);
  if (runtime.status.mode === "query-engine") {
    runtime.initialized = true;
    (strapi as any).log?.info?.("[search] mode=query-engine");
    return searchRuntimeStatus(strapi);
  }

  const connection = rankedConnection(strapi)!;
  let pgTrgmSchema: string | null = null;
  try {
    const extensionResult = await connection.raw(
      "SELECT extension_namespace.nspname AS schema_name " +
        "FROM pg_extension ext " +
        "JOIN pg_namespace extension_namespace " +
        "ON extension_namespace.oid = ext.extnamespace " +
        "WHERE ext.extname = 'pg_trgm'",
    );
    pgTrgmSchema = oneString(resultRows(extensionResult)[0]?.schema_name);
  } catch (error) {
    logSearchDiagnosticProblem(
      strapi,
      "[search] could not inspect pg_trgm: " +
        ((error as Error)?.message ?? String(error)),
    );
  }

  let tableSchema: string | null = null;
  try {
    tableSchema = await resolveSearchTableSchema(strapi, connection);
    if (!tableSchema) {
      logSearchDiagnosticProblem(
        strapi,
        "[search] could not resolve the Strapi table schema for search index diagnostics",
      );
    }
  } catch (error) {
    logSearchDiagnosticProblem(
      strapi,
      "[search] could not resolve the Strapi table schema: " +
        ((error as Error)?.message ?? String(error)),
    );
  }

  let indexRows: any[] = [];
  if (tableSchema) {
    try {
      const result = await connection.raw(
        "SELECT index_class.relname AS indexname, " +
          "?::text AS expected_schema, " +
          "table_namespace.nspname AS table_schema, " +
          "table_class.relname AS table_name, " +
          "access_method.amname AS access_method, " +
          "index_state.indnkeyatts AS key_count, " +
          "pg_get_indexdef(index_state.indexrelid, 1, true) AS expression, " +
          "opclass.opcname AS opclass_name, " +
          "opclass_namespace.nspname AS opclass_schema, " +
          "pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate, " +
          "index_state.indisvalid, index_state.indisready " +
          "FROM pg_index index_state " +
          "JOIN pg_class index_class ON index_class.oid = index_state.indexrelid " +
          "JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace " +
          "JOIN pg_class table_class ON table_class.oid = index_state.indrelid " +
          "JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace " +
          "JOIN pg_am access_method ON access_method.oid = index_class.relam " +
          "LEFT JOIN pg_opclass opclass ON opclass.oid = index_state.indclass[0] " +
          "LEFT JOIN pg_namespace opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace " +
          "WHERE index_namespace.nspname = ? " +
          "AND index_class.relname = ANY(?::text[])",
        [tableSchema, tableSchema, [...EXPECTED_SEARCH_INDEXES]],
      );
      indexRows = resultRows(result);
    } catch (error) {
      logSearchDiagnosticProblem(
        strapi,
        "[search] could not inspect expected indexes: " +
          ((error as Error)?.message ?? String(error)),
      );
    }
  }

  const byName = new Map(
    indexRows.map((row) => [String(row?.indexname ?? ""), row]),
  );
  const missingExpectedIndexes: string[] = [];
  const invalidExpectedIndexes: InvalidExpectedIndex[] = [];
  for (const expected of EXPECTED_SEARCH_INDEX_DEFINITIONS) {
    const row = byName.get(expected.name);
    if (!row) {
      missingExpectedIndexes.push(expected.name);
      continue;
    }
    const reason = invalidIndexReason(row, expected, pgTrgmSchema);
    if (reason) invalidExpectedIndexes.push({ name: expected.name, reason });
  }

  runtime.status = {
    mode: "postgres-sql",
    pgTrgmAvailable: pgTrgmSchema !== null,
    missingExpectedIndexes,
    invalidExpectedIndexes,
  };
  runtime.initialized = true;
  const status = searchRuntimeStatus(strapi);
  if (
    !status.pgTrgmAvailable ||
    status.missingExpectedIndexes.length > 0 ||
    status.invalidExpectedIndexes.length > 0
  ) {
    logSearchDiagnosticProblem(
      strapi,
      `[search] mode=${status.mode} pg_trgm=${status.pgTrgmAvailable ? "available" : "missing"}; ` +
        `missing expected indexes: ${status.missingExpectedIndexes.join(", ") || "none"}; ` +
        `invalid expected indexes: ${status.invalidExpectedIndexes
          .map(({ name, reason }) => `${name} (${reason})`)
          .join(", ") || "none"}. ` +
        `Search results remain correct, but may be slow. ` +
        `Automatic reconciliation runs after schema sync on every Strapi boot and will retry on the next boot; ` +
        `ensure the application database role may create pg_trgm and indexes if this persists.`,
    );
  } else {
    (strapi as any).log?.info?.(
      `[search] mode=${status.mode} pg_trgm=available missing_indexes=0 invalid_indexes=0`,
    );
  }
  return status;
}

export function searchRuntimeStatus(
  strapi: Core.Strapi,
): SearchRuntimeStatus {
  const status = runtimeFor(strapi).status;
  return {
    ...status,
    missingExpectedIndexes: [...status.missingExpectedIndexes],
    invalidExpectedIndexes: status.invalidExpectedIndexes.map((index) => ({
      ...index,
    })),
  };
}

// Test-only reset for suites that deliberately reuse one mock Strapi object.
export function resetSearchRuntime() {
  searchRuntimes = new WeakMap<object, SearchRuntime>();
}

export function configuredSqlConnection(strapi: Core.Strapi) {
  if (runtimeFor(strapi).status.mode === "query-engine") return null;
  const connection = rankedConnection(strapi);
  if (!connection) {
    throw new Error(
      "Search was bootstrapped for Postgres but its connection is unavailable",
    );
  }
  return connection;
}

export async function withSearchMode<T>(
  strapi: Core.Strapi,
  ranked: (connection: any) => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const connection = configuredSqlConnection(strapi);
  if (!connection) return fallback();
  try {
    return await ranked(connection);
  } catch (error) {
    // After bootstrap selects Postgres, a SQL failure is a real error: log it
    // and let the request fail like any other service error. Falling back here
    // would silently serve this page from a different scorer than its
    // neighbours (the pagination-reorder bug the fixed mode prevents).
    (strapi as any).log?.error?.(
      "search: Postgres SQL failed (" + ((error as Error)?.message ?? "") + ")",
    );
    throw error;
  }
}
