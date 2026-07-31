"use strict";

const UNIQUE_CODES_TABLE = "unique_codes";
const POOLS_TABLE = "unique_coupon_pools";
const POOL_LINK_TABLE = "unique_codes_pool_lnk";
const POOL_LINK_CODE_COLUMN = "unique_code_id";
const POOL_LINK_POOL_COLUMN = "unique_coupon_pool_id";
const POOL_CODE_GUARD = "unique_codes_pool_code_unique";
const CODE_LOOKUP_INDEX = "unique_codes_code_btree_idx";
const POOL_LINK_LOOKUP_INDEX = "unique_codes_pool_code_lookup_idx";
const UNCLAIMED_CODE_INDEX = "unique_codes_unclaimed_idx";
const CLAIM_TOKEN_INDEX = "unique_codes_claim_token_idx";
const LINK_CODE_LOOKUP_INDEX = "unique_codes_pool_lnk_code_idx";
const LINK_GUARD_TRIGGER = "unique_codes_pool_code_link_guard_v1";
const CODE_GUARD_TRIGGER = "unique_codes_pool_code_value_guard_v1";
const LINK_GUARD_FUNCTION = "cguru_unique_code_link_guard_v1";
const CODE_GUARD_FUNCTION = "cguru_unique_code_value_guard_v1";
const RECONCILE_LOCK = "couponzguru.unique-code-integrity.v2";

const POSTGRES_LOOKUP_INDEXES = Object.freeze([
  Object.freeze({
    name: CODE_LOOKUP_INDEX,
    table: UNIQUE_CODES_TABLE,
    columns: Object.freeze(["code", "id"]),
  }),
  Object.freeze({
    name: POOL_LINK_LOOKUP_INDEX,
    table: POOL_LINK_TABLE,
    columns: Object.freeze([
      POOL_LINK_POOL_COLUMN,
      POOL_LINK_CODE_COLUMN,
    ]),
  }),
  // Redemption's hot path. Without a partial index the "lowest-id unused code"
  // scan walks every already-spent code first, so a 99%-drained pool costs
  // ~100x a fresh one per claim — the exact moment a popular offer needs to be
  // fast. Indexing only the unused rows keeps the cost flat as stock depletes,
  // and the index shrinks as the pool drains.
  Object.freeze({
    name: UNCLAIMED_CODE_INDEX,
    table: UNIQUE_CODES_TABLE,
    columns: Object.freeze(["id"]),
    where: '"is_used" = false',
    requiredColumns: Object.freeze(["id", "is_used"]),
  }),
  // Backs replaying a claim to the activation that made it, and — because it is
  // UNIQUE — makes two in-flight requests for one activation collide in the
  // database instead of quietly claiming two codes.
  Object.freeze({
    name: CLAIM_TOKEN_INDEX,
    table: UNIQUE_CODES_TABLE,
    columns: Object.freeze(["claim_token"]),
    unique: true,
    where: '"claim_token" IS NOT NULL',
  }),
  // The EXISTS probe in the claim statement joins from the code to the link
  // row. Strapi usually creates this FK index itself; declaring it here means
  // the claim never degrades to a sequential scan if it did not.
  Object.freeze({
    name: LINK_CODE_LOOKUP_INDEX,
    table: POOL_LINK_TABLE,
    columns: Object.freeze([POOL_LINK_CODE_COLUMN]),
  }),
]);

const POSTGRES_CLIENTS = new Set(["pg", "postgres", "postgresql"]);

function postgresLookupIndexSql(index) {
  const columns = index.columns.map((column) => `"${column}"`).join(", ");
  // Not CONCURRENTLY: Strapi runs migrations, and bootstrap runs this
  // reconciliation, inside a transaction, and PostgreSQL forbids
  // CREATE INDEX CONCURRENTLY there. These tables are bounded (100,000 codes
  // per import) so the build holds its write lock briefly.
  return (
    `CREATE${index.unique ? " UNIQUE" : ""} INDEX IF NOT EXISTS ` +
    `"${index.name}" ON "${index.table}" (${columns})` +
    (index.where ? ` WHERE ${index.where}` : "")
  );
}

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
 * Strapi runs user migrations BEFORE schema sync, so on the pass that
 * introduces a new attribute its column does not exist yet and the index build
 * would abort the whole migration. Bootstrap calls this again after schema
 * sync, which is where such an index actually gets created.
 */
async function indexColumnsExist(knex, index) {
  const required = index.requiredColumns ?? index.columns;
  const present = await Promise.all(
    required.map((column) => knex.schema.hasColumn(index.table, column)),
  );
  return present.every(Boolean);
}

async function ensurePostgresLookupIndexes(knex) {
  if (!isPostgres(knex)) return false;
  const names = POSTGRES_LOOKUP_INDEXES.map((index) => index.name);
  const result = await knex.raw(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (${names.map(() => "?").join(", ")})`,
    names,
  );
  const existing = new Set(
    (result?.rows ?? []).map((row) => row.indexname),
  );

  for (const index of POSTGRES_LOOKUP_INDEXES) {
    if (existing.has(index.name)) continue;
    if (!(await indexColumnsExist(knex, index))) continue;
    await knex.raw(postgresLookupIndexSql(index));
  }
  return true;
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

      -- Serialize equal pool/code candidates across transactions. A trigger
      -- query alone cannot see another transaction's uncommitted link.
      PERFORM pg_advisory_xact_lock(
        hashtextextended(
          'couponzguru.unique-code:' ||
          NEW."${POOL_LINK_POOL_COLUMN}"::text || ':' || candidate_code,
          0
        )
      );

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
    DECLARE
      candidate_pool_id bigint;
    BEGIN
      IF NEW."code" IS NOT DISTINCT FROM OLD."code" THEN
        RETURN NEW;
      END IF;

      SELECT own_link."${POOL_LINK_POOL_COLUMN}"
        INTO candidate_pool_id
        FROM "${POOL_LINK_TABLE}" own_link
       WHERE own_link."${POOL_LINK_CODE_COLUMN}" = NEW."id"
       LIMIT 1;

      IF candidate_pool_id IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtextextended(
          'couponzguru.unique-code:' ||
          candidate_pool_id::text || ':' || NEW."code",
          0
        )
      );

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
           AND own_link."${POOL_LINK_POOL_COLUMN}" = candidate_pool_id
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

/**
 * Recompute pool counters from the code rows.
 *
 * Redemption deliberately no longer maintains `used_codes` inline — that write
 * targets one shared row, so doing it per claim would reserialize every
 * concurrent claimer and undo the SKIP LOCKED claim. The counters are display
 * values reconciled here instead; `getPoolStats` reports live numbers for
 * anything that needs to be exact.
 *
 * This also stamps `exhausted_at` for a pool that drained without anyone
 * clicking since — redemption stamps it on the drained edge, but a pool whose
 * last code went out and then saw no traffic would otherwise never be noticed.
 * A pool that has never held a code is left alone: an editor mid-setup must not
 * have their offers expired out from under them.
 */
/**
 * Must match CLAIM_REPLAY_WINDOW_MS in the unique-coupon service. The two are
 * halves of one rule: a claim token can be exchanged for its code for this
 * long, and is released once it cannot.
 */
const CLAIM_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Release claim tokens whose replay window has passed.
 *
 * The unique index on `claim_token` is permanent, but redemption only replays a
 * claim for 24 hours. Without this the two disagree: an activation id older
 * than the window can never be replayed AND can never claim again, because the
 * index keeps rejecting it. Clearing the column reconciles them, and stops a
 * write-once column from accumulating rows the index has to carry forever.
 */
async function releaseExpiredClaimTokens(knex, windowMs = CLAIM_REPLAY_WINDOW_MS) {
  if (!(await knex.schema.hasColumn(UNIQUE_CODES_TABLE, "claim_token"))) {
    return 0;
  }
  const cutoff = new Date(Date.now() - windowMs);
  const released = await knex(UNIQUE_CODES_TABLE)
    .whereNotNull("claim_token")
    .where((builder) =>
      builder.whereNull("used_at").orWhere("used_at", "<=", cutoff),
    )
    .update({ claim_token: null });
  return Number(released || 0);
}

async function recountPools(knex) {
  // One transaction, pool rows locked up front. `importCodes` takes the pool
  // row lock (`forUpdate`) for the whole restock, so locking here means a
  // concurrent import either committed before the aggregate below (its codes
  // are counted) or waits until this recount commits — a snapshot taken
  // between an import's insert and its counter bump can no longer be written
  // back over the finished restock, resurrecting stale counters and a
  // cleared `exhausted_at`. Import locks a single row, this locks all rows in
  // id order: no deadlock cycle. Nests as a savepoint when the caller already
  // holds a transaction (bootstrap does).
  // True when the caller already holds a transaction (bootstrap), making the
  // block below a savepoint rather than a real transaction.
  const nestedInCallerTransaction = Boolean(knex.isTransaction);
  await knex.transaction(async (trx) => {
    // Bound the nightly cron path so the recount can never hold (or wait on)
    // every pool lock indefinitely — e.g. behind a wedged import. On timeout
    // the statement errors, the cron logs it, and the next night retries.
    // Skipped when nested: SET LOCAL lasts to the END of the top-level
    // transaction (a released savepoint does not revert it), so applying it
    // here would silently impose these limits on the rest of the caller's
    // bootstrap transaction.
    if (!nestedInCallerTransaction) {
      await trx.raw(
        "SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'",
      );
    }
    const previous = await trx(POOLS_TABLE)
      .select("id", "exhausted_at")
      .orderBy("id")
      .forUpdate();
    if (previous.length === 0) return;
    const now = new Date();

    const counts = await trx(`${POOL_LINK_TABLE} as pool_link`)
      .join(
        `${UNIQUE_CODES_TABLE} as unique_code`,
        "unique_code.id",
        `pool_link.${POOL_LINK_CODE_COLUMN}`,
      )
      .select(`pool_link.${POOL_LINK_POOL_COLUMN} as pool_id`)
      .whereNotNull(`pool_link.${POOL_LINK_POOL_COLUMN}`)
      .count({ total_codes: "*" })
      .sum({
        used_codes: trx.raw("CASE WHEN ?? = ? THEN 1 ELSE 0 END", [
          "unique_code.is_used",
          true,
        ]),
      })
      .groupBy(`pool_link.${POOL_LINK_POOL_COLUMN}`);
    const countsByPool = new Map(counts.map((row) => [row.pool_id, row]));

    for (const pool of previous) {
      const row = countsByPool.get(pool.id);
      if (!row) {
        // No code rows: reset the display counters but leave `exhausted_at`
        // untouched — a pool that has never held a code (editor mid-setup)
        // must not be stamped, and one whose rows were deleted after draining
        // keeps its history.
        await trx(POOLS_TABLE)
          .where({ id: pool.id })
          .update({ total_codes: 0, used_codes: 0 });
        continue;
      }

      const total = Number(row.total_codes) || 0;
      const used = Number(row.used_codes) || 0;
      const drained = total > 0 && used >= total;

      await trx(POOLS_TABLE)
        .where({ id: pool.id })
        .update({
          total_codes: total,
          used_codes: used,
          // Keep the original timestamp when it is already set, so "when did
          // this run out" survives a reconciliation.
          exhausted_at: drained ? (pool.exhausted_at ?? now) : null,
        });
    }
  });
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
  await ensurePostgresLookupIndexes(knex);

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
  CLAIM_TOKEN_INDEX,
  CODE_LOOKUP_INDEX,
  CODE_GUARD_TRIGGER,
  LINK_CODE_LOOKUP_INDEX,
  LINK_GUARD_TRIGGER,
  POOL_CODE_GUARD,
  POOL_LINK_LOOKUP_INDEX,
  UNCLAIMED_CODE_INDEX,
  POOL_LINK_TABLE,
  POSTGRES_LOOKUP_INDEXES,
  chooseDuplicateKeeper,
  ensurePostgresLookupIndexes,
  installPostgresGuards,
  postgresLookupIndexSql,
  postgresGuardsExist,
  recountPools,
  releaseExpiredClaimTokens,
  reconcileUniqueCodeIntegrity,
  reconcileUniqueCodeIntegrityAfterSchemaSync,
};
