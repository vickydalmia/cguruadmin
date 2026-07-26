/**
 * Pre-launch migration repair for store/brand/category/bank `updated_at`
 * (and `created_at`). The migration plan invokes this after offer taxonomy
 * reconciliation; the standalone command remains available for dry runs and
 * targeted repair before editors begin changing content in Strapi.
 *
 * WHY: phase 03-taxonomies used to stamp all three timestamp columns with
 * `new Date()`. Those four tables own ~99% of the public URLs, so every entity
 * in the sitemap claimed it last changed on the day of the import — and every
 * re-import moved the whole catalogue's <lastmod> to "today". Google only uses
 * lastmod when it is verifiably accurate, and drops the signal site-wide when
 * it is not, so an import-stamped lastmod is worse than none at all.
 *
 * WordPress terms have no dates to import, but the offers filed under a term
 * are that page's content and DO carry real dates (phases 07/08 preserve
 * post_modified_gmt). This script derives, per entity:
 *
 *   updated_at ← MAX(offer.updated_at) over its coupons and deals
 *   created_at ← MIN(offer.created_at) over its coupons and deals
 *
 * The migration itself is fixed too (03-taxonomies.ts now reads the same range
 * straight from WordPress), so this script exists only so an existing database
 * can be corrected WITHOUT a full migrate:fresh.
 *
 * IMPORTANT: this deliberately replaces Strapi's entity system timestamps.
 * That is valid only while WordPress is the sole source of truth and nobody
 * has edited these entities in Strapi. Do not run it after the new site begins
 * accepting editorial changes.
 *
 * Entities with no offers are left untouched — there is no honest date for
 * them, and the sitemap omits <lastmod> rather than inventing one.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (the DEPLOYED database).
 * Dry-run prints counts; applying requires the host confirmation flag:
 *
 *   yarn backfill:entity-updated-at                              # dry-run
 *   yarn backfill:entity-updated-at --apply --yes-i-mean-<host>  # write
 *
 * NOTE: writes via SQL, bypassing the documents middleware — cached pages and
 * the sitemap stay stale until the next rebuild or the response cache expires.
 */

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

// entity table → the column naming it inside coupons_*_lnk / deals_*_lnk.
const ENTITY_TABLES: ReadonlyArray<{ table: string; linkColumn: string }> = [
  { table: "stores", linkColumn: "store_id" },
  { table: "brands", linkColumn: "brand_id" },
  { table: "categories", linkColumn: "category_id" },
  { table: "banks", linkColumn: "bank_id" },
];

const OFFER_SOURCES: ReadonlyArray<{ table: string; ownerColumn: string }> = [
  { table: "coupons", ownerColumn: "coupon_id" },
  { table: "deals", ownerColumn: "deal_id" },
];

async function tableExists(table: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

/**
 * One UNION ALL over the two link tables, then a single GROUP BY. Deliberately
 * not an OR-of-EXISTS: that shape inflated planner costs badly enough on this
 * database to trip JIT compilation and turn a fast query into a 17-second one.
 */
function aggregateSql(linkColumn: string, links: string[]): string {
  const arms = links
    .map(
      (link) => `
      SELECT l."${linkColumn}" AS entity_id, o."created_at", o."updated_at"
      FROM "${link}" l
      JOIN "${offerTableForLink(link)}" o ON o."id" = l."${ownerColumnForLink(link)}"
      WHERE o."content_status" = 'published'
        AND (o."expires_at" IS NULL OR o."expires_at" > NOW())`,
    )
    .join("\n      UNION ALL");

  return `
    WITH offer_dates AS (${arms})
    SELECT entity_id,
           MIN("created_at") AS first_created,
           MAX("updated_at") AS last_modified
    FROM offer_dates
    GROUP BY entity_id`;
}

function offerTableForLink(link: string): string {
  return link.startsWith("coupons_") ? "coupons" : "deals";
}

function ownerColumnForLink(link: string): string {
  return link.startsWith("coupons_") ? "coupon_id" : "deal_id";
}

async function backfillTable(
  entity: { table: string; linkColumn: string },
  apply: boolean,
): Promise<void> {
  const { table, linkColumn } = entity;

  const links: string[] = [];
  for (const source of OFFER_SOURCES) {
    const link = `${source.table}_${table}_lnk`;
    if (await tableExists(link)) links.push(link);
    else logger.warn(`${link} not found — skipping that relation for ${table}`);
  }

  if (links.length === 0) {
    logger.warn(`${table}: no link tables present, nothing to derive. Skipping.`);
    return;
  }

  const rows = await pgQuery<{
    entity_id: number;
    first_created: string | null;
    last_modified: string | null;
  }>(aggregateSql(linkColumn, links));

  const pending = rows.filter((row) => row.last_modified || row.first_created);
  logger.info(
    `${table}: ${pending.length} row(s) with derivable dates ${apply ? "to update" : "would change"}`,
  );
  if (!apply || pending.length === 0) return;

  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const tuples: string[] = [];
    const params: Array<number | string | null> = [];
    chunk.forEach((row, idx) => {
      const b = idx * 3;
      tuples.push(`($${b + 1}::int, $${b + 2}::timestamptz, $${b + 3}::timestamptz)`);
      params.push(row.entity_id, row.first_created, row.last_modified);
    });

    // COALESCE so a relation that yielded only one of the two dates does not
    // null out the other.
    await pgQuery(
      `UPDATE "${table}" AS e SET
         "created_at" = COALESCE(v."first_created", e."created_at"),
         "updated_at" = COALESCE(v."last_modified", e."updated_at")
       FROM (VALUES ${tuples.join(", ")}) AS v(entity_id, first_created, last_modified)
       WHERE e."id" = v.entity_id`,
      params,
    );
    done += chunk.length;
    logger.info(`${table}: updated ${done}/${pending.length}`);
  }
}

export async function runEntityUpdatedAtBackfill(
  apply: boolean,
): Promise<void> {
  for (const entity of ENTITY_TABLES) {
    await backfillTable(entity, apply);
  }
  if (!apply) {
    logger.info("Dry-run complete — pass --apply --yes-i-mean-<host> to write.");
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  logger.info(
    `backfill-entity-updated-at target host: ${host} (${apply ? "APPLY" : "dry-run"})`,
  );
  if (apply) {
    logger.warn(
      "PRE-LAUNCH ONLY: this replaces entity system timestamps from visible WordPress offer dates.",
    );
  }
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply updates store/brand/category/bank timestamps on ${host}. ` +
        `Re-run with --yes-i-mean-${host} to confirm.`,
    );
    process.exit(1);
  }

  try {
    await runEntityUpdatedAtBackfill(apply);
  } catch (err: any) {
    logger.error(`Backfill failed: ${err.message}`);
    logger.error(err.stack);
    process.exitCode = 1;
  } finally {
    await closePg();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
