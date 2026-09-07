/**
 * One-off data repair: contain legacy HTML in every richtext column of a
 * DEPLOYED database, without re-importing.
 *
 * Background: the WordPress theme stored `store_short_description` (and, on
 * some sites, other richtext) as `<font size="2"><p>…` with neither tag
 * closed — 311 of the 802 Singapore terms. The public site injects these
 * fields with `set:html`, and an unclosed formatting element is not contained
 * by the element it is rendered into: the browser re-creates it around every
 * later inline node, so one store page carried ~670 injected `<font>`
 * elements inside coupon cards and headings and rendered visibly broken.
 *
 * The import now sanitizes the field and the CMS sanitizes every write; this
 * script brings the rows already stored on India, USA, UAE and Singapore up
 * to the same state. Every column in RICHTEXT_FIELDS is covered (description,
 * shortDescription, festiveOfferDescription, coupon/deal content), in every
 * locale, draft and published alike.
 *
 * Conservative by design: a row is rewritten only when the allowlist changes
 * its ELEMENT STRUCTURE (a dropped `<font>`, a closed `<p>`). Entity and
 * attribute-only differences are left for the next editor save, so clean rows
 * stay byte-identical and translation fingerprints do not churn.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (migration/.env.migration
 * by default — i.e. the DEPLOYED database). Dry-run prints the diff; applying
 * requires an explicit confirmation flag matching that host (same guard as
 * fix-markdown-richtext):
 *
 *   yarn fix:richtext-html                              # dry-run
 *   yarn fix:richtext-html --apply --yes-i-mean-<host>  # write
 *
 * PUBLIC_SITE_URL must be set (in .env.migration or the shell) to the site the
 * database serves: the shared sanitizer classifies links against it, and an
 * unset value marks every absolute link nofollow. --apply refuses without it.
 *
 * NOTE: writes via SQL, bypassing the documents middleware — no ISR
 * invalidation is emitted. Run a Website Refresh from the admin afterwards so
 * cached pages are re-rendered.
 */

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
import { structuralRepair } from "./utils/richtext-repair.js";
// Sanitizer + table/column targets shared with the other fix scripts; the
// module throws at import on an unmapped uid, keeping startup fail-fast.
import { cleanHtml, RICHTEXT_TARGETS } from "./utils/richtext-targets.js";

const BATCH = 500;

async function main() {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;

  logger.info(`fix-richtext-html target host: ${host} (${apply ? "APPLY" : "dry-run"})`);
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply rewrites richtext columns on ${host}. ` +
        `Re-run with --yes-i-mean-${host} to confirm.`
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env.PUBLIC_SITE_URL?.trim()) {
    const message =
      "PUBLIC_SITE_URL is not set: the sanitizer cannot tell internal links from " +
      "external ones and would mark every absolute link nofollow.";
    if (apply) {
      logger.error(`Refusing to write: ${message}`);
      process.exitCode = 1;
      return;
    }
    logger.warn(`${message} Dry-run output may over-report link changes.`);
  }

  const perTarget: Record<string, number> = {};
  let totalChanged = 0;

  for (const { table, column } of RICHTEXT_TARGETS) {
    let changed = 0;
    let lastId = 0;
    for (;;) {
      // Only rows that contain markup can need repair.
      const rows = await pgQuery<{ id: number; value: string }>(
        `SELECT id, ${column} AS value FROM ${table}
         WHERE id > $1 AND ${column} LIKE '%<%'
         ORDER BY id
         LIMIT $2`,
        [lastId, BATCH]
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        lastId = Number(row.id);
        if (typeof row.value !== "string") continue;
        const repaired = structuralRepair(row.value, cleanHtml);
        if (repaired === null) continue;

        changed += 1;
        logger.info(`--- ${table}.${column} id=${row.id} ---`);
        logger.info(`BEFORE: ${JSON.stringify(row.value.slice(0, 300))}`);
        logger.info(`AFTER : ${JSON.stringify(repaired.slice(0, 300))}`);

        if (apply) {
          await pgQuery(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [
            repaired,
            row.id,
          ]);
          logger.info("UPDATED");
        }
      }
    }
    perTarget[`${table}.${column}`] = changed;
    totalChanged += changed;
  }

  logger.info(`per column: ${JSON.stringify(perTarget)}`);
  logger.info(
    `${totalChanged} row(s) ${apply ? "updated" : "would change (dry-run — pass --apply to write)"}`
  );
  if (apply && totalChanged > 0) {
    logger.info(
      "Rows were written directly; run a Website Refresh from the admin so cached pages re-render."
    );
  }
}

main()
  .catch((err) => {
    logger.error(`fix-richtext-html failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => closePg());
