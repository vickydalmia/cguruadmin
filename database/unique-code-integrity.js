"use strict";

const UNIQUE_CODES_TABLE = "unique_codes";
const POOLS_TABLE = "unique_coupon_pools";
const POOL_CODE_INDEX = "unique_codes_pool_code_unique";
const RECONCILE_LOCK = "couponzguru.unique-code-integrity.v1";

const POSTGRES_CLIENTS = new Set(["pg", "postgres", "postgresql"]);
const SQLITE_CLIENTS = new Set(["sqlite", "sqlite3", "better-sqlite3"]);

function databaseClient(knex) {
  return String(knex?.client?.config?.client || "").toLowerCase();
}

function isPostgres(knex) {
  return POSTGRES_CLIENTS.has(databaseClient(knex));
}

function isSqlite(knex) {
  return SQLITE_CLIENTS.has(databaseClient(knex));
}

function isUsed(row) {
  return row?.is_used === true || row?.is_used === 1 ||
    row?.is_used === "1" || row?.is_used === "true";
}

function timestamp(value) {
  if (value == null || value === "") return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Pick the single row retained from one duplicate (pool_id, code) group.
 * A redeemed code wins over an unused copy so a migration never makes a code
 * redeemable again. Among redeemed copies, the earliest redemption is the
 * canonical history; ids provide a deterministic final tie-break.
 */
function chooseDuplicateKeeper(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  const usedRows = rows.filter(isUsed);
  const candidates = usedRows.length > 0 ? usedRows : rows;

  return [...candidates].sort((left, right) => {
    if (usedRows.length > 0) {
      const leftUsedAt = timestamp(left.used_at);
      const rightUsedAt = timestamp(right.used_at);
      if (leftUsedAt !== rightUsedAt) {
        return leftUsedAt < rightUsedAt ? -1 : 1;
      }
    }
    return Number(left.id) - Number(right.id);
  })[0];
}

async function acquireReconcileLock(knex) {
  if (!isPostgres(knex)) return;
  await knex.raw(
    "SELECT pg_advisory_xact_lock(hashtext(?))",
    [RECONCILE_LOCK],
  );
}

async function namedIndexDefinition(knex) {
  if (isPostgres(knex)) {
    const result = await knex.raw(
      "SELECT indexdef FROM pg_indexes " +
        "WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?",
      [UNIQUE_CODES_TABLE, POOL_CODE_INDEX],
    );
    return result?.rows?.[0]?.indexdef ?? null;
  }

  if (isSqlite(knex)) {
    const result = await knex.raw(`PRAGMA index_list('${UNIQUE_CODES_TABLE}')`);
    const rows = Array.isArray(result) ? result : result?.rows ?? [];
    const found = rows.find((row) => row?.name === POOL_CODE_INDEX);
    if (!found) return null;

    const columnsResult = await knex.raw(
      `PRAGMA index_info('${POOL_CODE_INDEX}')`,
    );
    const columns = Array.isArray(columnsResult)
      ? columnsResult
      : columnsResult?.rows ?? [];
    return {
      unique: Number(found.unique) === 1,
      columns: [...columns]
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((row) => String(row.name)),
    };
  }

  const result = await knex.raw(
    "SELECT non_unique, column_name, seq_in_index " +
      "FROM information_schema.statistics " +
      "WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? " +
      "ORDER BY seq_in_index",
    [UNIQUE_CODES_TABLE, POOL_CODE_INDEX],
  );
  const rows = result?.[0] ?? result?.rows ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows;
}

function indexDefinitionIsExpected(knex, definition) {
  if (!definition) return false;

  if (isPostgres(knex)) {
    const canonical = String(definition)
      .toLowerCase()
      .replace(/["`\s]/gu, "");
    return canonical.includes("createuniqueindex") &&
      canonical.includes(UNIQUE_CODES_TABLE) &&
      canonical.includes("(pool_id,code)");
  }

  if (isSqlite(knex)) {
    return definition.unique === true &&
      definition.columns?.length === 2 &&
      definition.columns[0] === "pool_id" &&
      definition.columns[1] === "code";
  }

  return definition.length === 2 &&
    definition.every((row) => Number(row.non_unique) === 0) &&
    String(definition[0].column_name) === "pool_id" &&
    String(definition[1].column_name) === "code";
}

async function ensurePoolCodeUniqueIndex(knex) {
  const existing = await namedIndexDefinition(knex);
  if (existing) {
    if (!indexDefinitionIsExpected(knex, existing)) {
      throw new Error(
        `${POOL_CODE_INDEX} exists but is not the expected unique (pool_id, code) index`,
      );
    }
    return false;
  }

  if (isPostgres(knex) || isSqlite(knex)) {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${POOL_CODE_INDEX}" ` +
        `ON "${UNIQUE_CODES_TABLE}" ("pool_id", "code")`,
    );
  } else {
    await knex.schema.alterTable(UNIQUE_CODES_TABLE, (table) => {
      table.unique(["pool_id", "code"], POOL_CODE_INDEX);
    });
  }
  return true;
}

async function removeDuplicateCodes(knex) {
  const groups = await knex(UNIQUE_CODES_TABLE)
    .select("pool_id", "code")
    .whereNotNull("pool_id")
    .whereNotNull("code")
    .groupBy("pool_id", "code")
    .havingRaw("COUNT(*) > 1");

  let removed = 0;
  for (const group of groups) {
    const rows = await knex(UNIQUE_CODES_TABLE)
      .where({ pool_id: group.pool_id, code: group.code })
      .select("id", "is_used", "used_at");
    const keeper = chooseDuplicateKeeper(rows);
    const duplicateIds = rows
      .filter((row) => row.id !== keeper?.id)
      .map((row) => row.id);

    if (duplicateIds.length > 0) {
      await knex(UNIQUE_CODES_TABLE).whereIn("id", duplicateIds).delete();
      removed += duplicateIds.length;
    }
  }
  return removed;
}

async function recountPools(knex) {
  await knex(POOLS_TABLE).update({ total_codes: 0, used_codes: 0 });

  const counts = await knex(UNIQUE_CODES_TABLE)
    .select("pool_id")
    .whereNotNull("pool_id")
    .count({ total_codes: "*" })
    .sum({
      used_codes: knex.raw("CASE WHEN ?? = ? THEN 1 ELSE 0 END", [
        "is_used",
        true,
      ]),
    })
    .groupBy("pool_id");

  for (const row of counts) {
    await knex(POOLS_TABLE)
      .where({ id: row.pool_id })
      .update({
        total_codes: Number(row.total_codes) || 0,
        used_codes: Number(row.used_codes) || 0,
      });
  }
}

/**
 * Run inside the caller's transaction. Strapi runs user migrations before
 * schema sync on a fresh database, so an absent table is an expected skip;
 * bootstrap invokes the same function after schema sync.
 */
async function reconcileUniqueCodeIntegrity(knex, logger = console) {
  const hasCodes = await knex.schema.hasTable(UNIQUE_CODES_TABLE);
  const hasPools = await knex.schema.hasTable(POOLS_TABLE);
  if (!hasCodes || !hasPools) {
    logger.info(
      "Unique-code integrity: tables are not available yet; bootstrap will retry after schema sync",
    );
    return { attempted: false, removed: 0, indexCreated: false };
  }

  await acquireReconcileLock(knex);

  // Creating the unique index REQUIRES a duplicate-free table, so the
  // duplicate scan cannot simply run after it. But once the index exists it
  // makes duplicates impossible, so the full-table GROUP BY that
  // removeDuplicateCodes pays is pointless on every healthy boot. Check the
  // index first (without creating): present and well-formed → skip the scan
  // entirely; missing → dedupe, then create, exactly as before.
  const existingIndex = await namedIndexDefinition(knex);
  if (existingIndex) {
    if (!indexDefinitionIsExpected(knex, existingIndex)) {
      throw new Error(
        `${POOL_CODE_INDEX} exists but is not the expected unique (pool_id, code) index`,
      );
    }
    return { attempted: true, removed: 0, indexCreated: false };
  }

  const removed = await removeDuplicateCodes(knex);
  const indexCreated = await ensurePoolCodeUniqueIndex(knex);
  if (removed > 0 || indexCreated) {
    await recountPools(knex);
  }

  if (removed > 0) {
    logger.warn(
      `Unique-code integrity: removed ${removed} duplicate row${removed === 1 ? "" : "s"}`,
    );
  }
  return { attempted: true, removed, indexCreated };
}

async function reconcileUniqueCodeIntegrityAfterSchemaSync(
  knex,
  logger = console,
) {
  return knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx, logger));
}

module.exports = {
  POOL_CODE_INDEX,
  chooseDuplicateKeeper,
  indexDefinitionIsExpected,
  reconcileUniqueCodeIntegrity,
  reconcileUniqueCodeIntegrityAfterSchemaSync,
};
