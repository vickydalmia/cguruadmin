/**
 * One-off post-migration cleanup: DROP the legacy columns/tables left behind by
 * the tag / offerType / Amazon-deal / isPopular / cashbackItems removals. Strapi
 * never drops columns or tables on its own (it orphans them to avoid data loss),
 * so this has to be run by hand on an already-migrated database.
 *
 * Removes:
 *   Columns   coupons/deals.is_popular, coupons/deals.offer_type,
 *             globals.enable_amazon_deal, globals.amazon_top_banner_link
 *   Media     files_related_mph rows for global.amazonTopBanner
 *   Component coupons_cmps/deals_cmps rows for cashbackItems (shared.chip),
 *             then the components_shared_chips table
 *   Tables    coupons_tags_lnk, deals_tags_lnk, tags
 *
 * RUN ORDER: after backfill-offer-fields.ts — this drops `is_popular`, which the
 * badge backfill reads. Everything is guarded (IF EXISTS / scoped DELETEs), so a
 * DB that never had a given object is a safe no-op, and re-runs are idempotent.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (the DEPLOYED database).
 * Dry-run reports what exists; applying requires the host confirmation flag:
 *
 *   yarn cleanup:legacy-fields                              # dry-run (report only)
 *   yarn cleanup:legacy-fields --apply --yes-i-mean-<host>  # execute the drops
 */

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";

// [table, column] columns to drop.
const COLUMN_DROPS: Array<[string, string]> = [
  ["coupons", "is_popular"],
  ["deals", "is_popular"],
  ["coupons", "offer_type"],
  ["deals", "offer_type"],
  ["globals", "enable_amazon_deal"],
  ["globals", "amazon_top_banner_link"],
];

// [componentJoinTable, field] rows to delete (removed repeatable components).
const CMPS_DELETES: Array<[string, string]> = [
  ["coupons_cmps", "cashbackItems"],
  ["deals_cmps", "cashbackItems"],
];

// Tables to drop, ordered so FK-referencing tables go before their targets.
const TABLE_DROPS = [
  "coupons_tags_lnk",
  "deals_tags_lnk",
  "components_shared_chips",
  "tags",
];

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

async function countRows(sql: string, params: any[]): Promise<number> {
  try {
    const [{ c }] = await pgQuery<{ c: string }>(sql, params);
    return Number(c);
  } catch {
    return 0; // table absent — nothing to delete
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  logger.info(`drop-legacy-fields target host: ${host} (${apply ? "APPLY" : "dry-run"})`);
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply drops columns/tables on ${host}. ` +
        `Re-run with --yes-i-mean-${host} to confirm.`,
    );
    process.exit(1);
  }

  try {
    // 1. Component rows (delete before dropping the component data table).
    for (const [table, field] of CMPS_DELETES) {
      if (!(await tableExists(table))) continue;
      const n = await countRows(
        `SELECT COUNT(*)::text AS c FROM "${table}" WHERE field = $1`,
        [field],
      );
      if (apply && n > 0) {
        await pgQuery(`DELETE FROM "${table}" WHERE field = $1`, [field]);
      }
      logger.info(`${table}[field=${field}]: ${n} row(s) ${apply ? "deleted" : "would delete"}`);
    }

    // 2. Media morph rows for global.amazonTopBanner.
    if (await tableExists("files_related_mph")) {
      const n = await countRows(
        `SELECT COUNT(*)::text AS c FROM "files_related_mph"
         WHERE related_type = $1 AND field = $2`,
        ["api::global.global", "amazonTopBanner"],
      );
      if (apply && n > 0) {
        await pgQuery(
          `DELETE FROM "files_related_mph" WHERE related_type = $1 AND field = $2`,
          ["api::global.global", "amazonTopBanner"],
        );
      }
      logger.info(`files_related_mph[amazonTopBanner]: ${n} row(s) ${apply ? "deleted" : "would delete"}`);
    }

    // 3. Columns.
    for (const [table, column] of COLUMN_DROPS) {
      const exists = await columnExists(table, column);
      if (apply && exists) {
        await pgQuery(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`);
      }
      logger.info(`${table}.${column}: ${exists ? (apply ? "dropped" : "would drop") : "absent (skip)"}`);
    }

    // 4. Tables.
    for (const table of TABLE_DROPS) {
      const exists = await tableExists(table);
      if (apply && exists) {
        await pgQuery(`DROP TABLE IF EXISTS "${table}"`);
      }
      logger.info(`table ${table}: ${exists ? (apply ? "dropped" : "would drop") : "absent (skip)"}`);
    }

    if (!apply) {
      logger.info("Dry-run complete — pass --apply --yes-i-mean-<host> to execute the drops.");
    }
  } catch (err: any) {
    logger.error(`Cleanup failed: ${err.message}`);
    logger.error(err.stack);
    process.exit(1);
  } finally {
    await closePg();
  }
}

main();
