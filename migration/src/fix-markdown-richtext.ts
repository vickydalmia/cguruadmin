/**
 * One-off data repair: convert stray MARKDOWN syntax inside richtext columns
 * to real HTML.
 *
 * Background: richtext fields store HTML (rendered raw on the site), but the
 * pre-TipTap admin editor was markdown-based — anything edited there between
 * migration and the WYSIWYG rollout may contain literal "- item" bullet lines
 * or **bold** markers that display as plain text on store pages (QC bug,
 * 13/07/2026).
 *
 * Conservative by design: only touches rows matching a markdown pattern, only
 * converts leading-bullet/numbered lines and bold markers (double-asterisk or
 * double-underscore), then re-runs the standard cleanHtml allowlist.
 * Everything else passes through byte-identical.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (migration/.env.migration
 * by default — i.e. the DEPLOYED database). Dry-run prints the diff; applying
 * requires an explicit confirmation flag matching that host (same guard as
 * reset-homepage):
 *
 *   yarn fix:markdown-richtext                              # dry-run
 *   yarn fix:markdown-richtext --apply --yes-i-mean-<host>  # write
 *
 * NOTE: writes via SQL, bypassing the documents middleware — static pages for
 * changed entries stay stale until the next rebuild/edit.
 */

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
// Sanitizer + table/column targets shared with fix-content-srcsets; the
// module throws at import on an unmapped uid, keeping this script's startup
// fail-fast (before any DB connection or the confirmation-flag check).
import { cleanHtml, RICHTEXT_TARGETS } from "./utils/richtext-targets.js";

// Rows worth looking at: a line starting with "- " / "* " / "+ " / "1. ",
// or a **bold** marker pair.
const DETECT_SQL = String.raw`(^|\n)\s*([-*+] |\d+[.)] )`;

function inlineMd(text: string, state: { converted: boolean }): string {
  // Bold pairs must hug their content (no space just inside the markers):
  // "**bold**" converts, but stray-asterisk noise like "2** get **1" does not.
  const replaced = text
    .replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(\S(?:[^_\n]*\S)?)__/g, "<strong>$1</strong>");
  if (replaced !== text) state.converted = true;
  return replaced;
}

/**
 * Returns null when nothing markdown-ish was actually converted, so callers
 * can skip rows that merely matched the coarse SQL detection (e.g. tables
 * whose only "change" would be \r\n → \n line-ending noise).
 */
function convertMarkdownArtifacts(html: string): string | null {
  const state = { converted: false };
  const lines = html.split(/\r?\n/);
  const out: string[] = [];
  let list: {
    type: "ul" | "ol";
    items: string[];
    rawLines: string[];
    firstNumber: number;
  } | null = null;

  const flush = () => {
    if (!list) return;
    // A lone "numbered" line is usually prose that starts with a number
    // ("1999. Later expanded") — only treat it as a list when it's a real
    // sequence (2+ items) or a deliberate single-item list starting at 1.
    // Bullets ("- item") are unambiguous even alone.
    const isRealList =
      list.type === "ul" || list.items.length >= 2 || list.firstNumber === 1;
    if (isRealList) {
      out.push(
        `<${list.type}>` +
          list.items.map((item) => `<li>${item}</li>`).join("") +
          `</${list.type}>`
      );
      state.converted = true;
    } else {
      out.push(...list.rawLines);
    }
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(line);

    if (bullet || numbered) {
      const type: "ul" | "ol" = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flush();
        list = {
          type,
          items: [],
          rawLines: [],
          firstNumber: numbered ? Number(numbered[1]) : 0,
        };
      }
      list.items.push(inlineMd(bullet ? bullet[1] : numbered![2], state));
      list.rawLines.push(inlineMd(raw, state));
      continue;
    }

    flush();
    out.push(inlineMd(raw, state));
  }
  flush();
  return state.converted ? out.join("\n") : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;

  logger.info(`fix-markdown-richtext target host: ${host} (${apply ? "APPLY" : "dry-run"})`);
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply updates richtext columns on ${host}. ` +
        `Re-run with --yes-i-mean-${host} to confirm.`
    );
    process.exitCode = 1;
    return;
  }

  let totalChanged = 0;
  for (const { table, column } of RICHTEXT_TARGETS) {
    const rows = await pgQuery<{ id: number; value: string }>(
      `SELECT id, ${column} AS value FROM ${table}
       WHERE ${column} ~ $1 OR ${column} LIKE '%**%'
       ORDER BY id`,
      [DETECT_SQL]
    );

    for (const row of rows) {
      const convertedRaw = convertMarkdownArtifacts(row.value);
      if (convertedRaw == null) continue; // matched detection but nothing to convert
      const converted = cleanHtml(convertedRaw);
      if (converted === row.value) continue;

      totalChanged += 1;
      logger.info(`--- ${table}.${column} id=${row.id} ---`);
      logger.info(`BEFORE: ${JSON.stringify(row.value.slice(0, 300))}`);
      logger.info(`AFTER : ${JSON.stringify((converted ?? "").slice(0, 300))}`);

      if (apply) {
        await pgQuery(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [
          converted,
          row.id,
        ]);
        logger.info("UPDATED");
      }
    }
  }

  logger.info(
    `${totalChanged} row(s) ${apply ? "updated" : "would change (dry-run — pass --apply to write)"}`
  );
}

main()
  .catch((err) => {
    logger.error(`fix-markdown-richtext failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => closePg());
