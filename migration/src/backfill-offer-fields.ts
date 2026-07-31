/**
 * One-off post-migration backfill for coupons & deals that were migrated BEFORE
 * these fields existed. Populates, on an ALREADY-migrated database:
 *
 *   - `badge`           ← 'Recommended' where the legacy `is_popular` is true
 *   - Coupon `offer_text` ← extracted from title (falling back to content)
 *   - `cashback_text`   ← extracted amount, e.g. "15%"
 *   - `bank_offer_text` ← extracted amount, e.g. "12%" / "₹2000"
 *   - `prepaid_text`    ← extracted amount, e.g. "5%" / "₹100"
 *
 * The benefit columns store the BARE AMOUNT — the public API appends the
 * wording ("Cashback" / "Bank OFF" / "Prepaid OFF") on the way out.
 *
 * Fill-only: every field is written ONLY where it is currently NULL, so editor
 * edits and re-runs are never clobbered (idempotent). Uses the same extraction
 * as phases 07/08 (utils/offer-extract) so benefit values match a fresh run;
 * offer_text applies only to Coupon phase 07.
 *
 * PREREQUISITE: deploy the new schema and boot Strapi ONCE first — Strapi adds
 * the new nullable columns (badge plus the benefit columns, and Coupon
 * offer_text) on boot; this script only fills them. Run this BEFORE drop-legacy-fields (that
 * script removes `is_popular`, which the badge backfill reads).
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (the DEPLOYED database).
 * Dry-run prints counts; applying requires the host confirmation flag:
 *
 *   yarn backfill:offer-fields                              # dry-run
 *   yarn backfill:offer-fields --apply --yes-i-mean-<host>  # write (fill-only)
 *   yarn backfill:offer-fields --apply --reextract --yes-i-mean-<host>
 *       # re-derive offer/cashback/bank/prepaid text for ALL rows (clears them first),
 *       # e.g. after improving the extractor. `badge` is left untouched.
 *
 * NOTE: writes via SQL, bypassing the documents middleware — static pages for
 * changed entries stay stale until the next rebuild/edit.
 */

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
import { extractOfferText, extractCashbackFields } from "./utils/offer-extract.js";

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

// badge ← is_popular (bulk). Requires both columns to still exist: run this
// before the cleanup script drops is_popular.
async function backfillBadge(table: string, apply: boolean): Promise<void> {
  if (!(await columnExists(table, "badge"))) {
    logger.warn(`${table}.badge column not found — boot Strapi first so it creates the column. Skipping.`);
    return;
  }
  if (!(await columnExists(table, "is_popular"))) {
    logger.warn(`${table}.is_popular column not found — already dropped? Skipping badge backfill.`);
    return;
  }
  const [{ c }] = await pgQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM "${table}" WHERE "is_popular" = true AND "badge" IS NULL`,
  );
  const count = Number(c);
  if (apply && count > 0) {
    await pgQuery(
      `UPDATE "${table}" SET "badge" = 'Recommended' WHERE "is_popular" = true AND "badge" IS NULL`,
    );
  }
  logger.info(`${table}: ${count} row(s) ${apply ? "updated" : "would change"} — badge ← 'Recommended'`);
}

// Coupon offer_text plus the three benefit texts are extracted per row. Deals
// carry only the benefit texts; their promotion copy belongs to `discount`.
// reextract=true clears and re-derives only the columns applicable to the
// table.
async function backfillTexts(table: string, apply: boolean, reextract: boolean): Promise<void> {
  const includeOfferText = table === "coupons";
  const columns = [
    ...(includeOfferText ? ["offer_text"] : []),
    "cashback_text",
    "bank_offer_text",
    "prepaid_text",
  ];
  for (const col of columns) {
    if (!(await columnExists(table, col))) {
      logger.warn(`${table}.${col} column not found — boot Strapi first. Skipping text backfill for ${table}.`);
      return;
    }
  }

  if (reextract && apply) {
    await pgQuery(
      `UPDATE "${table}" SET ${columns.map((column) => `"${column}" = NULL`).join(", ")}`,
    );
    logger.info(`${table}: cleared ${columns.join("/")} for re-extraction`);
  }

  const rows = await pgQuery<{
    id: number;
    title: string | null;
    content: string | null;
    offer_text?: string | null;
    cashback_text: string | null;
    bank_offer_text: string | null;
    prepaid_text: string | null;
  }>(
    `SELECT id, title, content, ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"` +
      (reextract
        ? ""
        : ` WHERE ${columns.map((column) => `"${column}" IS NULL`).join(" OR ")}`),
  );

  logger.info(`${table}: scanning ${rows.length} row(s) with a null ${columns.join("/")} field…`);

  // Extract in memory, collect only rows that gained a value.
  type Pending = {
    id: number;
    offer_text: string | null;
    cashback_text: string | null;
    bank_offer_text: string | null;
    prepaid_text: string | null;
  };
  const pending: Pending[] = [];
  for (const row of rows) {
    let offer_text: string | null = null;
    let cashback_text: string | null = null;
    let bank_offer_text: string | null = null;
    let prepaid_text: string | null = null;
    if (includeOfferText && row.offer_text == null) {
      offer_text = extractOfferText(row.title, row.content);
    }
    if (row.cashback_text == null || row.bank_offer_text == null || row.prepaid_text == null) {
      const extracted = extractCashbackFields(row.title, row.content);
      if (row.cashback_text == null) cashback_text = extracted.cashbackText;
      if (row.bank_offer_text == null) bank_offer_text = extracted.bankOfferText;
      if (row.prepaid_text == null) prepaid_text = extracted.prepaidText;
    }
    if (offer_text || cashback_text || bank_offer_text || prepaid_text) {
      pending.push({ id: row.id, offer_text, cashback_text, bank_offer_text, prepaid_text });
    }
  }

  logger.info(`${table}: ${pending.length} row(s) ${apply ? "to update" : "would change"} — ${columns.join("/")}`);
  if (!apply || pending.length === 0) return;

  // Batch writes: one UPDATE … FROM (VALUES …) per chunk instead of a round-trip
  // per row. COALESCE keeps any existing (non-null) value — fill-only semantics.
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    if (!includeOfferText) {
      const tuples: string[] = [];
      const params: Array<number | string | null> = [];
      chunk.forEach((row, idx) => {
        const b = idx * 4;
        tuples.push(`($${b + 1}::int, $${b + 2}::text, $${b + 3}::text, $${b + 4}::text)`);
        params.push(row.id, row.cashback_text, row.bank_offer_text, row.prepaid_text);
      });
      await pgQuery(
        `UPDATE "${table}" AS c SET
           "cashback_text" = COALESCE(c."cashback_text", v."cashback_text"),
           "bank_offer_text" = COALESCE(c."bank_offer_text", v."bank_offer_text"),
           "prepaid_text" = COALESCE(c."prepaid_text", v."prepaid_text")
         FROM (VALUES ${tuples.join(", ")}) AS v(id, cashback_text, bank_offer_text, prepaid_text)
         WHERE c.id = v.id`,
        params,
      );
      done += chunk.length;
      logger.info(`${table}: updated ${done}/${pending.length}`);
      continue;
    }
    const tuples: string[] = [];
    const params: Array<number | string | null> = [];
    chunk.forEach((row, idx) => {
      const b = idx * 5;
      tuples.push(`($${b + 1}::int, $${b + 2}::text, $${b + 3}::text, $${b + 4}::text, $${b + 5}::text)`);
      params.push(row.id, row.offer_text, row.cashback_text, row.bank_offer_text, row.prepaid_text);
    });
    await pgQuery(
      `UPDATE "${table}" AS c SET
         "offer_text" = COALESCE(c."offer_text", v."offer_text"),
         "cashback_text" = COALESCE(c."cashback_text", v."cashback_text"),
         "bank_offer_text" = COALESCE(c."bank_offer_text", v."bank_offer_text"),
         "prepaid_text" = COALESCE(c."prepaid_text", v."prepaid_text")
       FROM (VALUES ${tuples.join(", ")}) AS v(id, offer_text, cashback_text, bank_offer_text, prepaid_text)
       WHERE c.id = v.id`,
      params,
    );
    done += chunk.length;
    logger.info(`${table}: updated ${done}/${pending.length}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  // --reextract: clear + re-derive offer/cashback/bank text for ALL rows (use
  // after extraction-logic changes; discards prior auto-extracted values).
  const reextract = process.argv.includes("--reextract");
  const host = new URL(config.pg.connectionString).hostname;
  logger.info(
    `backfill-offer-fields target host: ${host} (${apply ? "APPLY" : "dry-run"}${reextract ? ", RE-EXTRACT" : ""})`,
  );
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply updates coupons/deals on ${host}. ` +
        `Re-run with --yes-i-mean-${host} to confirm.`,
    );
    process.exit(1);
  }

  try {
    for (const table of ["coupons", "deals"]) {
      await backfillBadge(table, apply);
      await backfillTexts(table, apply, reextract);
    }
    if (!apply) {
      logger.info("Dry-run complete — pass --apply --yes-i-mean-<host> to write.");
    }
  } catch (err: any) {
    logger.error(`Backfill failed: ${err.message}`);
    logger.error(err.stack);
    process.exit(1);
  } finally {
    await closePg();
  }
}

main();
