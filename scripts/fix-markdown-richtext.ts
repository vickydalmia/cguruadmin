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
 * Run (dry-run first, then apply):
 *   yarn fix:markdown-richtext
 *   yarn fix:markdown-richtext --apply
 *
 * NOTE: writes via SQL, bypassing the documents middleware — static pages for
 * changed entries stay stale until the next rebuild/edit.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { cleanHtml, RICHTEXT_FIELDS } from '../src/utils/sanitize-richtext';

// DB table per content-type uid (Strapi table names come from each schema's
// collectionName, not mechanical pluralization — so map explicitly). Derived
// from RICHTEXT_FIELDS so a richtext field added there cannot be silently
// skipped here: an unmapped uid fails fast below instead.
const TABLE_BY_UID: Record<string, string> = {
  'api::deal.deal': 'deals',
  'api::coupon.coupon': 'coupons',
  'api::category.category': 'categories',
  'api::bank.bank': 'banks',
  'api::brand.brand': 'brands',
  'api::store.store': 'stores',
};

const TARGETS: Array<{ table: string; column: string }> = Object.entries(
  RICHTEXT_FIELDS
).flatMap(([uid, fields]) => {
  const table = TABLE_BY_UID[uid];
  if (!table) {
    throw new Error(
      `RICHTEXT_FIELDS has "${uid}" but TABLE_BY_UID has no table for it — add the mapping`
    );
  }
  return fields.map((column) => ({ table, column }));
});

// Rows worth looking at: a line starting with "- " / "* " / "+ " / "1. ",
// or a **bold** marker pair.
const DETECT_SQL = String.raw`(^|\n)\s*([-*+] |\d+[.)] )`;

function inlineMd(text: string, state: { converted: boolean }): string {
  // Bold pairs must hug their content (no space just inside the markers):
  // "**bold**" converts, but stray-asterisk noise like "2** get **1" does not.
  const replaced = text
    .replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(\S(?:[^_\n]*\S)?)__/g, '<strong>$1</strong>');
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
    type: 'ul' | 'ol';
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
      list.type === 'ul' || list.items.length >= 2 || list.firstNumber === 1;
    if (isRealList) {
      out.push(
        `<${list.type}>` +
          list.items.map((item) => `<li>${item}</li>`).join('') +
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
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
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
  return state.converted ? out.join('\n') : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  let totalChanged = 0;
  for (const { table, column } of TARGETS) {
    const { rows } = await client.query(
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
      console.log(`\n--- ${table}.${column} id=${row.id} ---`);
      console.log('BEFORE:', JSON.stringify(row.value.slice(0, 300)));
      console.log('AFTER :', JSON.stringify((converted ?? '').slice(0, 300)));

      if (apply) {
        await client.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [
          converted,
          row.id,
        ]);
        console.log('UPDATED');
      }
    }
  }

  console.log(
    `\n${totalChanged} row(s) ${apply ? 'updated' : 'would change (dry-run — pass --apply to write)'}`
  );
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
