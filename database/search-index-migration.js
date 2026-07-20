"use strict";

const POSTGRES_CLIENTS = new Set(["pg", "postgres", "postgresql"]);

const PUBLIC_SEARCH_INDEX_TARGETS = [
  ["stores", "name"],
  ["brands", "name"],
  ["categories", "name"],
  ["banks", "name"],
  ["coupons", "title"],
  ["deals", "title"],
];

const RANK_SEARCH_INDEX_TARGETS = [
  ["stores", "slug"],
  ["brands", "slug"],
  ["categories", "slug"],
  ["banks", "slug"],
  ["coupons", "code"],
];

const EXPECTED_SEARCH_INDEX_TARGETS = [
  ...PUBLIC_SEARCH_INDEX_TARGETS,
  ...RANK_SEARCH_INDEX_TARGETS,
];

const OPTIONAL_DDL_CODES = new Set([
  "42501", // insufficient_privilege
  "55P03", // lock_not_available (includes lock_timeout)
  "40P01", // deadlock_detected
  "57014", // query_canceled / statement timeout
]);
const OPTIONAL_EXTENSION_CODES = new Set([
  ...OPTIONAL_DDL_CODES,
  "0A000", // feature_not_supported / extension is not available
  "58P01", // undefined_file / missing extension control file
]);
const SEARCH_DDL_LOCK_TIMEOUT = "5s";
const SEARCH_DDL_STATEMENT_TIMEOUT = "30s";
const SEARCH_RECONCILE_ADVISORY_LOCK = "couponzguru.search-index-reconcile.v1";

function isPostgres(knex) {
  return POSTGRES_CLIENTS.has(
    String(knex?.client?.config?.client || "").toLowerCase(),
  );
}

function errorCode(error) {
  return String(
    error?.code || error?.original?.code || error?.parent?.code || "",
  );
}

function isExpectedOptionalError(error, kind) {
  const code = errorCode(error);
  const expectedCodes =
    kind === "extension" ? OPTIONAL_EXTENSION_CODES : OPTIONAL_DDL_CODES;
  if (expectedCodes.has(code)) return true;

  const message = String(error?.message || error || "");
  if (
    kind === "index" &&
    code === "42704" &&
    /operator class [^\n]*gin_trgm_ops[^\n]* does not exist for access method ["']?gin["']?/iu.test(
      message,
    )
  ) {
    return true;
  }
  const permissionOrLock =
    /permission denied|must be superuser|lock timeout|could not obtain lock|deadlock detected|canceling statement due to (?:lock|statement) timeout/iu;
  if (permissionOrLock.test(message)) return true;
  return (
    kind === "extension" &&
    /extension .+ is not available|extension control file/iu.test(message)
  );
}

async function configureOptionalDdlTimeouts(knex) {
  // Strapi wraps each user migration in its own transaction. SET LOCAL keeps
  // these bounds scoped to that migration and, crucially, makes the handled
  // lock/statement timeout paths reachable instead of allowing boot to wait
  // forever behind another transaction.
  await knex.raw(`SET LOCAL lock_timeout = '${SEARCH_DDL_LOCK_TIMEOUT}'`);
  await knex.raw(
    `SET LOCAL statement_timeout = '${SEARCH_DDL_STATEMENT_TIMEOUT}'`,
  );
}

async function acquireSearchReconcileLock(
  knex,
  operationName,
  logger = console,
) {
  const result = await knex.raw(
    "SELECT pg_try_advisory_xact_lock(hashtext(?)) AS acquired",
    [SEARCH_RECONCILE_ADVISORY_LOCK],
  );
  if (result?.rows?.[0]?.acquired === true) return true;
  logger.warn(
    `${operationName}: another instance is reconciling search indexes — ` +
      "skipping this pass without waiting; automatic reconciliation retries on the next boot",
  );
  return false;
}

async function rollbackSavepoint(knex, savepoint) {
  await knex.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await knex.raw(`RELEASE SAVEPOINT ${savepoint}`);
}

async function runOptionalDdl(
  knex,
  { savepoint, sql, bindings = [], statements, kind },
) {
  await knex.raw(`SAVEPOINT ${savepoint}`);
  try {
    if (statements) {
      for (const statement of statements) {
        await knex.raw(statement.sql, statement.bindings || []);
      }
    } else {
      await knex.raw(sql, bindings);
    }
  } catch (error) {
    // PostgreSQL marks the surrounding transaction aborted after any DDL
    // error. Always recover the nested savepoint before deciding whether the
    // error is an expected optional failure or a real schema defect.
    await rollbackSavepoint(knex, savepoint);
    if (isExpectedOptionalError(error, kind)) {
      return { ok: false, error };
    }
    throw error;
  }
  await knex.raw(`RELEASE SAVEPOINT ${savepoint}`);
  return { ok: true };
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/gu, '""')}"`;
}

function configuredDatabaseSchema(knex) {
  const schema = knex?.client?.config?.connection?.schema;
  return typeof schema === "string" && schema.trim() ? schema.trim() : null;
}

async function resolveTableSchema(knex, table) {
  const configuredSchema = configuredDatabaseSchema(knex);
  const relationName = configuredSchema
    ? `${quoteIdentifier(configuredSchema)}.${quoteIdentifier(table)}`
    : quoteIdentifier(table);
  const result = await knex.raw(
    "SELECT table_namespace.nspname AS schema_name " +
      "FROM pg_class table_class " +
      "JOIN pg_namespace table_namespace " +
      "ON table_namespace.oid = table_class.relnamespace " +
      "WHERE table_class.oid = to_regclass(?) " +
      "AND table_class.relkind IN ('r', 'p')",
    [relationName],
  );
  const schemaName = result?.rows?.[0]?.schema_name;
  return typeof schemaName === "string" && schemaName.length > 0
    ? schemaName
    : null;
}

function canonicalIndexExpression(value) {
  return String(value ?? "")
    .replace(/\s+/gu, "")
    .replace(/::(?:text|charactervarying)/giu, "")
    .replace(/"/gu, "")
    .replace(/\(([a-z_][a-z0-9_$]*)\)/giu, "$1")
    .replace(/^translate(?=\()/iu, "translate");
}

function expectedIndexExpression(column) {
  return (
    `translate(${column},` +
    `'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`
  );
}

async function inspectExpectedIndex(
  knex,
  { schemaName, table, column, index, pgTrgmSchema },
) {
  const result = await knex.raw(
    "SELECT table_namespace.nspname AS table_schema, " +
      "table_class.relname AS table_name, " +
      "access_method.amname AS access_method, " +
      "index_state.indnkeyatts AS key_count, " +
      "pg_get_indexdef(index_state.indexrelid, 1, true) AS expression, " +
      "opclass.opcname AS opclass_name, " +
      "opclass_namespace.nspname AS opclass_schema, " +
      "pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate, " +
      "index_state.indisvalid, index_state.indisready " +
      "FROM pg_class index_class " +
      "JOIN pg_namespace index_namespace " +
      "ON index_namespace.oid = index_class.relnamespace " +
      "JOIN pg_index index_state ON index_state.indexrelid = index_class.oid " +
      "JOIN pg_class table_class ON table_class.oid = index_state.indrelid " +
      "JOIN pg_namespace table_namespace " +
      "ON table_namespace.oid = table_class.relnamespace " +
      "JOIN pg_am access_method ON access_method.oid = index_class.relam " +
      "LEFT JOIN pg_opclass opclass ON opclass.oid = index_state.indclass[0] " +
      "LEFT JOIN pg_namespace opclass_namespace " +
      "ON opclass_namespace.oid = opclass.opcnamespace " +
      "WHERE index_namespace.nspname = ? AND index_class.relname = ? " +
      "LIMIT 1",
    [schemaName, index],
  );
  const row = result?.rows?.[0];
  if (!row) return { exists: false, healthy: false };

  const healthy =
    String(row.table_schema || "") === schemaName &&
    String(row.table_name || "") === table &&
    String(row.access_method || "") === "gin" &&
    Number(row.key_count) === 1 &&
    canonicalIndexExpression(row.expression) ===
      expectedIndexExpression(column) &&
    String(row.opclass_name || "") === "gin_trgm_ops" &&
    String(row.opclass_schema || "") === pgTrgmSchema &&
    row.predicate == null &&
    row.indisvalid === true &&
    row.indisready === true;
  return { exists: true, healthy };
}

function safeSavepointPart(value) {
  return String(value).replace(/[^a-z0-9_]/giu, "_").slice(0, 32);
}

async function pgTrgmSchema(knex) {
  const catalog = await knex.raw(
    "SELECT extension_namespace.nspname AS schema_name " +
      "FROM pg_extension ext " +
      "JOIN pg_namespace extension_namespace " +
      "ON extension_namespace.oid = ext.extnamespace " +
      "WHERE ext.extname = 'pg_trgm'",
  );
  const schemaName = catalog?.rows?.[0]?.schema_name;
  return typeof schemaName === "string" && schemaName.length > 0
    ? schemaName
    : null;
}

async function ensurePgTrgm(knex, migrationName, logger = console) {
  // The normal healthy-boot path is catalog-only. Avoid even
  // CREATE EXTENSION IF NOT EXISTS unless the extension is actually absent.
  const existingSchema = await pgTrgmSchema(knex);
  if (existingSchema) return existingSchema;

  const result = await runOptionalDdl(knex, {
    savepoint: `search_ext_${safeSavepointPart(migrationName)}`,
    sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    kind: "extension",
  });
  if (!result.ok) {
    logger.warn(
      `${migrationName}: cannot enable pg_trgm (${result.error.message}) — ` +
        "skipping optional trigram indexes; search remains correct but may be slower",
    );
    return null;
  }

  const schemaName = await pgTrgmSchema(knex);
  if (!schemaName) {
    logger.warn(
      `${migrationName}: pg_trgm extension schema could not be discovered — ` +
        "skipping optional trigram indexes; search remains correct but may be slower",
    );
    return null;
  }
  return schemaName;
}

async function reconcileSearchIndexes(
  knex,
  migrationName,
  targets,
  pgTrgmSchema,
  logger = console,
  { stopAfterOptionalFailure = false } = {},
) {
  let reconciled = 0;
  const missingTables = [];
  for (const [position, [table, column]] of targets.entries()) {
    // Strapi 5 runs database/migrations BEFORE schema sync creates the
    // content tables, so a completely fresh database reaches this DDL with
    // no tables at all and CREATE INDEX would abort boot with 42P01
    // (undefined_table). Check inside the same migration transaction and
    // skip absent tables; the consolidated warning below explains why the
    // skip is permanent for this boot path.
    const tableSchema = await resolveTableSchema(knex, table);
    if (!tableSchema) {
      if (!missingTables.includes(table)) missingTables.push(table);
      continue;
    }
    const index = `${table}_${column}_search_trgm_idx`;
    const existing = await inspectExpectedIndex(knex, {
      schemaName: tableSchema,
      table,
      column,
      index,
      pgTrgmSchema,
    });
    if (existing.healthy) continue;

    const statements = [];
    if (existing.exists) {
      statements.push({
        sql: "DROP INDEX IF EXISTS ??.??",
        bindings: [tableSchema, index],
      });
    }
    statements.push({
      sql:
        "CREATE INDEX IF NOT EXISTS ?? ON ??.?? USING gin (" +
        "translate(??, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') " +
        "??.gin_trgm_ops)",
      bindings: [index, tableSchema, table, column, pgTrgmSchema],
    });
    const result = await runOptionalDdl(knex, {
      savepoint:
        `search_idx_${safeSavepointPart(migrationName)}_${position}`.slice(
          0,
          63,
        ),
      statements,
      kind: "index",
    });
    if (result.ok) {
      reconciled += 1;
    } else {
      logger.warn(
        `${migrationName}: cannot reconcile ${index} (${result.error.message}) — ` +
          "continuing without this optional index; automatic reconciliation will retry on the next boot",
      );
      if (stopAfterOptionalFailure) break;
    }
  }
  if (missingTables.length > 0) {
    logger.warn(
      `${migrationName}: tables not created yet (${missingTables.join(", ")}) — ` +
        "skipped their search indexes; Strapi bootstrap retries automatically after schema sync",
    );
  }
  return reconciled;
}

async function reconcileSearchIndexesAfterSchemaSync(knex, logger = console) {
  if (!isPostgres(knex)) return { attempted: false, reconciled: 0 };
  try {
    let reconciled = 0;
    await knex.transaction(async (transaction) => {
      await configureOptionalDdlTimeouts(transaction);
      // Multiple Strapi instances may bootstrap together. Serialize the
      // inspect/drop/create sequence so one instance cannot drop an index that
      // another instance has just repaired. Never wait behind that instance:
      // this process can diagnose current state and retry on its next boot.
      const migrationName = "search-index-bootstrap";
      const acquired = await acquireSearchReconcileLock(
        transaction,
        migrationName,
        logger,
      );
      if (!acquired) return;
      const pgTrgmSchema = await ensurePgTrgm(transaction, migrationName, logger);
      if (!pgTrgmSchema) return;
      reconciled = await reconcileSearchIndexes(
        transaction,
        migrationName,
        EXPECTED_SEARCH_INDEX_TARGETS,
        pgTrgmSchema,
        logger,
        { stopAfterOptionalFailure: true },
      );
    });
    if (reconciled > 0) {
      logger.info?.(
        `[search] automatically reconciled ${reconciled} search index${reconciled === 1 ? "" : "es"} after schema sync`,
      );
    }
    return { attempted: true, reconciled };
  } catch (error) {
    // Indexes are performance aids. An unavailable extension, DDL permission,
    // or bounded lock/statement timeout must never make Strapi unavailable.
    logger.error?.(
      `[search] automatic index reconciliation could not complete (${error?.message || error}); search remains correct and reconciliation will retry on the next boot`,
    );
    return { attempted: true, reconciled: 0, error };
  }
}

module.exports = {
  EXPECTED_SEARCH_INDEX_TARGETS,
  PUBLIC_SEARCH_INDEX_TARGETS,
  RANK_SEARCH_INDEX_TARGETS,
  acquireSearchReconcileLock,
  configureOptionalDdlTimeouts,
  ensurePgTrgm,
  errorCode,
  isExpectedOptionalError,
  isPostgres,
  reconcileSearchIndexes,
  reconcileSearchIndexesAfterSchemaSync,
  runOptionalDdl,
};
