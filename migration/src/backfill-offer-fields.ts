/**
 * One-off post-migration backfill for coupons & deals that were migrated BEFORE
 * these fields existed. Populates, on an ALREADY-migrated database:
 *
 *   - `badge`           ← 'Recommended' where the legacy `is_popular` is true
 *   - `offer_text`      ← extracted from title (falling back to content)
 *   - `cashback_text`   ← extracted "N% Cashback"
 *   - `bank_offer_text` ← extracted "N% Bank OFF"
 *
 * Fill-only: every field is written ONLY where it is currently NULL, so editor
 * edits and re-runs are never clobbered (idempotent). Uses the same extraction
 * as phases 07/08 (utils/offer-extract) so backfilled values match a fresh run.
 *
 * PREREQUISITE: deploy the new schema and boot Strapi ONCE first — Strapi adds
 * the new nullable columns (badge/offer_text/cashback_text/bank_offer_text) on
 * boot; this script only fills them. Run this BEFORE drop-legacy-fields (that
 * script removes `is_popular`, which the badge backfill reads).
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (the DEPLOYED database).
 * Dry-run prints counts; applying requires the host confirmation flag:
 *
 *   yarn backfill:offer-fields                              # dry-run
 *   yarn backfill:offer-fields --apply --yes-i-mean-<host>  # write
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

// offer_text / cashback_text / bank_offer_text ← extracted per row.
async function backfillTexts(table: string, apply: boolean): Promise<void> {
  for (const col of ["offer_text", "cashback_text", "bank_offer_text"]) {
    if (!(await columnExists(table, col))) {
      logger.warn(`${table}.${col} column not found — boot Strapi first. Skipping text backfill for ${table}.`);
      return;
    }
  }

  const rows = await pgQuery<{
    id: number;
    title: string | null;
    content: string | null;
    offer_text: string | null;
    cashback_text: string | null;
    bank_offer_text: string | null;
  }>(
    `SELECT id, title, content, offer_text, cashback_text, bank_offer_text FROM "${table}"
     WHERE offer_text IS NULL OR cashback_text IS NULL OR bank_offer_text IS NULL`,
  );

  let changed = 0;
  for (const row of rows) {
    const updates: Record<string, string> = {};
    if (row.offer_text == null) {
      const value = extractOfferText(row.title, row.content);
      if (value) updates.offer_text = value;
    }
    if (row.cashback_text == null || row.bank_offer_text == null) {
      const { cashbackText, bankOfferText } = extractCashbackFields(row.title, row.content);
      if (row.cashback_text == null && cashbackText) updates.cashback_text = cashbackText;
      if (row.bank_offer_text == null && bankOfferText) updates.bank_offer_text = bankOfferText;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) continue;
    changed++;
    if (apply) {
      const set = keys.map((key, i) => `"${key}" = $${i + 1}`).join(", ");
      await pgQuery(`UPDATE "${table}" SET ${set} WHERE id = $${keys.length + 1}`, [
        ...keys.map((key) => updates[key]),
        row.id,
      ]);
    }
  }
  logger.info(
    `${table}: ${changed} row(s) ${apply ? "updated" : "would change"} — offer/cashback/bank text (scanned ${rows.length} with a null field)`,
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  logger.info(`backfill-offer-fields target host: ${host} (${apply ? "APPLY" : "dry-run"})`);
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
      await backfillTexts(table, apply);
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
