"use strict";

const UNIQUE_CODES_TABLE = "unique_codes";
const POOLS_TABLE = "unique_coupon_pools";
const POOL_LINK_TABLE = "unique_codes_pool_lnk";
const POOL_LINK_CODE_COLUMN = "unique_code_id";
const POOL_LINK_POOL_COLUMN = "unique_coupon_pool_id";
const POOL_CODE_GUARD = "unique_codes_pool_code_unique";
const LINK_GUARD_TRIGGER = "unique_codes_pool_code_link_guard_v1";
const CODE_GUARD_TRIGGER = "unique_codes_pool_code_value_guard_v1";
const LINK_GUARD_FUNCTION = "cguru_unique_code_link_guard_v1";
const CODE_GUARD_FUNCTION = "cguru_unique_code_value_guard_v1";
const RECONCILE_LOCK = "couponzguru.unique-code-integrity.v2";

const POSTGRES_CLIENTS = new Set(["pg", "postgres", "postgresql"]);

function databaseClient(knex) {
  return String(knex?.client?.config?.client || "").toLowerCase();
}

function isPostgres(knex) {
  return POSTGRES_CLIENTS.has(databaseClient(knex));
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
 * Pick the single row retained from one duplicate (pool, code) group.
 * A redeemed code wins over an unused copy so reconciliation never makes a
 * redeemed code available again. Existing Strapi ids/documentIds are retained;
 * reconciliation never manufactures another pool identity.
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

async function postgresGuardsExist(knex) {
  if (!isPostgres(knex)) return false;
  const result = await knex.raw(
    `SELECT COUNT(*)::int AS count
       FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (?, ?)`,
    [LINK_GUARD_TRIGGER, CODE_GUARD_TRIGGER],
  );
  return Number(result?.rows?.[0]?.count ?? 0) === 2;
}

/**
 * PostgreSQL cannot express a unique constraint whose key spans the Strapi
 * relation table and the related row's code value. Two small triggers provide
 * that final database boundary without adding a duplicate pool_id column:
 *
 * - linking a code to a pool rejects an existing equal code in that pool;
 * - changing a linked code value performs the same check.
 */
async function installPostgresGuards(knex) {
  if (!isPostgres(knex)) return false;

  await knex.raw(`
    CREATE OR REPLACE FUNCTION "${LINK_GUARD_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      candidate_code text;
    BEGIN
      SELECT "code"
        INTO candidate_code
        FROM "${UNIQUE_CODES_TABLE}"
       WHERE "id" = NEW."${POOL_LINK_CODE_COLUMN}";

      IF candidate_code IS NULL THEN
        RETURN NEW;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM "${POOL_LINK_TABLE}" existing_link
          JOIN "${UNIQUE_CODES_TABLE}" existing_code
            ON existing_code."id" = existing_link."${POOL_LINK_CODE_COLUMN}"
         WHERE existing_link."${POOL_LINK_POOL_COLUMN}" =
               NEW."${POOL_LINK_POOL_COLUMN}"
           AND existing_link."${POOL_LINK_CODE_COLUMN}" <>
               NEW."${POOL_LINK_CODE_COLUMN}"
           AND existing_code."code" = candidate_code
      ) THEN
        RAISE EXCEPTION 'duplicate unique coupon code in pool'
          USING ERRCODE = '23505',
                CONSTRAINT = '${POOL_CODE_GUARD}';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION "${CODE_GUARD_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."code" IS NOT DISTINCT FROM OLD."code" THEN
        RETURN NEW;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM "${POOL_LINK_TABLE}" own_link
          JOIN "${POOL_LINK_TABLE}" existing_link
            ON existing_link."${POOL_LINK_POOL_COLUMN}" =
               own_link."${POOL_LINK_POOL_COLUMN}"
           AND existing_link."${POOL_LINK_CODE_COLUMN}" <> NEW."id"
          JOIN "${UNIQUE_CODES_TABLE}" existing_code
            ON existing_code."id" =
               existing_link."${POOL_LINK_CODE_COLUMN}"
         WHERE own_link."${POOL_LINK_CODE_COLUMN}" = NEW."id"
           AND existing_code."code" = NEW."code"
      ) THEN
        RAISE EXCEPTION 'duplicate unique coupon code in pool'
          USING ERRCODE = '23505',
                CONSTRAINT = '${POOL_CODE_GUARD}';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  await knex.raw(
    `DROP TRIGGER IF EXISTS "${LINK_GUARD_TRIGGER}" ` +
      `ON "${POOL_LINK_TABLE}"`,
  );
  await knex.raw(`
    CREATE TRIGGER "${LINK_GUARD_TRIGGER}"
    BEFORE INSERT OR UPDATE OF
      "${POOL_LINK_CODE_COLUMN}", "${POOL_LINK_POOL_COLUMN}"
    ON "${POOL_LINK_TABLE}"
    FOR EACH ROW
    EXECUTE FUNCTION "${LINK_GUARD_FUNCTION}"()
  `);

  await knex.raw(
    `DROP TRIGGER IF EXISTS "${CODE_GUARD_TRIGGER}" ` +
      `ON "${UNIQUE_CODES_TABLE}"`,
  );
  await knex.raw(`
    CREATE TRIGGER "${CODE_GUARD_TRIGGER}"
    BEFORE UPDATE OF "code"
    ON "${UNIQUE_CODES_TABLE}"
    FOR EACH ROW
    EXECUTE FUNCTION "${CODE_GUARD_FUNCTION}"()
  `);

  return true;
}

async function removeDuplicateCodes(knex) {
  const groups = await knex(`${POOL_LINK_TABLE} as pool_link`)
    .join(
      `${UNIQUE_CODES_TABLE} as unique_code`,
      `unique_code.id`,
      `pool_link.${POOL_LINK_CODE_COLUMN}`,
    )
    .select(
      `pool_link.${POOL_LINK_POOL_COLUMN} as pool_id`,
      "unique_code.code",
    )
    .whereNotNull(`pool_link.${POOL_LINK_POOL_COLUMN}`)
    .whereNotNull("unique_code.code")
    .groupBy(
      `pool_link.${POOL_LINK_POOL_COLUMN}`,
      "unique_code.code",
    )
    .havingRaw("COUNT(*) > 1");

  let removed = 0;
  for (const group of groups) {
    const rows = await knex(`${POOL_LINK_TABLE} as pool_link`)
      .join(
        `${UNIQUE_CODES_TABLE} as unique_code`,
        "unique_code.id",
        `pool_link.${POOL_LINK_CODE_COLUMN}`,
      )
      .where(`pool_link.${POOL_LINK_POOL_COLUMN}`, group.pool_id)
      .where("unique_code.code", group.code)
      .select(
        "unique_code.id",
        "unique_code.is_used",
        "unique_code.used_at",
      );
    const keeper = chooseDuplicateKeeper(rows);
    const duplicateIds = rows
      .filter((row) => row.id !== keeper?.id)
      .map((row) => row.id);

    if (duplicateIds.length > 0) {
      await knex(POOL_LINK_TABLE)
        .whereIn(POOL_LINK_CODE_COLUMN, duplicateIds)
        .delete();
      await knex(UNIQUE_CODES_TABLE).whereIn("id", duplicateIds).delete();
      removed += duplicateIds.length;
    }
  }
  return removed;
}

async function recountPools(knex) {
  await knex(POOLS_TABLE).update({ total_codes: 0, used_codes: 0 });

  const counts = await knex(`${POOL_LINK_TABLE} as pool_link`)
    .join(
      `${UNIQUE_CODES_TABLE} as unique_code`,
      "unique_code.id",
      `pool_link.${POOL_LINK_CODE_COLUMN}`,
    )
    .select(`pool_link.${POOL_LINK_POOL_COLUMN} as pool_id`)
    .whereNotNull(`pool_link.${POOL_LINK_POOL_COLUMN}`)
    .count({ total_codes: "*" })
    .sum({
      used_codes: knex.raw("CASE WHEN ?? = ? THEN 1 ELSE 0 END", [
        "unique_code.is_used",
        true,
      ]),
    })
    .groupBy(`pool_link.${POOL_LINK_POOL_COLUMN}`);

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
 * schema sync on a fresh database, so absent relation tables are an expected
 * skip; bootstrap invokes the same function again after schema sync.
 */
async function reconcileUniqueCodeIntegrity(knex, logger = console) {
  const [hasCodes, hasPools, hasLinks] = await Promise.all([
    knex.schema.hasTable(UNIQUE_CODES_TABLE),
    knex.schema.hasTable(POOLS_TABLE),
    knex.schema.hasTable(POOL_LINK_TABLE),
  ]);
  if (!hasCodes || !hasPools || !hasLinks) {
    logger.info(
      "Unique-code integrity: tables are not available yet; bootstrap will retry after schema sync",
    );
    return { attempted: false, removed: 0, guardCreated: false };
  }

  await acquireReconcileLock(knex);

  if (await postgresGuardsExist(knex)) {
    return { attempted: true, removed: 0, guardCreated: false };
  }

  const removed = await removeDuplicateCodes(knex);
  const guardCreated = await installPostgresGuards(knex);
  await recountPools(knex);

  if (removed > 0) {
    logger.warn(
      `Unique-code integrity: removed ${removed} duplicate row${removed === 1 ? "" : "s"}`,
    );
  }
  return { attempted: true, removed, guardCreated };
}

async function reconcileUniqueCodeIntegrityAfterSchemaSync(
  knex,
  logger = console,
) {
  return knex.transaction((trx) => reconcileUniqueCodeIntegrity(trx, logger));
}

module.exports = {
  CODE_GUARD_TRIGGER,
  LINK_GUARD_TRIGGER,
  POOL_CODE_GUARD,
  POOL_LINK_TABLE,
  chooseDuplicateKeeper,
  installPostgresGuards,
  postgresGuardsExist,
  reconcileUniqueCodeIntegrity,
  reconcileUniqueCodeIntegrityAfterSchemaSync,
};
