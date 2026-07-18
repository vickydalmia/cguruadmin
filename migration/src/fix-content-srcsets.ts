/**
 * One-off data repair: rebuild the srcset/sizes of migrated rich-text <img>
 * tags from the CURRENT files.formats.
 *
 * Background: content HTML is written once at migration time and never
 * re-rendered, so <img> srcsets are frozen at whatever variant matrix existed
 * back then — tags rewritten before the xsmall(320) rung landed stop at 500w
 * even after the phase-15 formats backfill adds the missing variants.
 *
 * Deliberately LOW VALUE: rich-text srcsets already carry the 245w thumbnail
 * rung, so small viewports have a small candidate today. This is opt-in
 * parity tooling to run (or not) after `migrate:phase -- 15-media-formats-
 * backfill` — the decision is the operator's.
 *
 * Only <img> tags whose src is the migrated master URL (host matching
 * config.s3.baseUrl) are touched; hand-edited tags referencing variant URLs
 * miss the files.url lookup and are logged + left as-is. Rebuilt HTML re-runs
 * the standard cleanHtml allowlist, and rows whose output is byte-identical
 * are skipped.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (migration/.env.migration
 * by default — i.e. the DEPLOYED database). Dry-run prints the diff; applying
 * requires an explicit confirmation flag matching that host (same guard as
 * fix-markdown-richtext):
 *
 *   yarn fix:content-srcsets                              # dry-run
 *   yarn fix:content-srcsets --apply --yes-i-mean-<host>  # write
 *
 * NOTE: writes via SQL, bypassing the documents middleware — static pages for
 * changed entries stay stale until the next rebuild/edit.
 */

import { createRequire } from "node:module";
import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
// rebuildImgTag composes the srcset via buildSrcset internally — both are
// exported from content-media so this script and the migration cannot drift.
import { rebuildImgTag } from "./utils/content-media.js";
import type { UploadedFileRecord } from "./phases/02-media-upload.js";
// The main package owns the richtext allowlist and field registry; load it
// from there so the two can never drift. createRequire (not import) because
// the main package is CommonJS while this one is ESM — tsx compiles the TS
// across the boundary but Node's named-export detection can't see through it.
const require = createRequire(import.meta.url);
const { cleanHtml, RICHTEXT_FIELDS } =
  require("../../src/utils/sanitize-richtext") as {
    cleanHtml: (html: string) => string;
    RICHTEXT_FIELDS: Record<string, string[]>;
  };

// DB table per content-type uid (Strapi table names come from each schema's
// collectionName, not mechanical pluralization — so map explicitly). Derived
// from RICHTEXT_FIELDS so a richtext field added there cannot be silently
// skipped here: an unmapped uid fails fast below instead.
const TABLE_BY_UID: Record<string, string> = {
  "api::deal.deal": "deals",
  "api::coupon.coupon": "coupons",
  "api::category.category": "categories",
  "api::bank.bank": "banks",
  "api::brand.brand": "brands",
  "api::store.store": "stores",
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

function parseFormats(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value as Record<string, any>;
}

// files lookups cached per URL — the same master appears across many rows.
const recordByUrl = new Map<string, Promise<UploadedFileRecord | undefined>>();

function lookupFileByUrl(url: string): Promise<UploadedFileRecord | undefined> {
  let task = recordByUrl.get(url);
  if (!task) {
    task = (async () => {
      const rows = await pgQuery<{
        id: number;
        url: string;
        formats: unknown;
        width: number | null;
        height: number | null;
      }>(`SELECT id, url, formats, width, height FROM files WHERE url = $1`, [url]);
      if (!rows[0]) return undefined;
      return {
        id: rows[0].id,
        url: rows[0].url,
        formats: parseFormats(rows[0].formats),
        width: rows[0].width,
        height: rows[0].height,
      };
    })();
    recordByUrl.set(url, task);
  }
  return task;
}

function getSrc(tag: string): string | undefined {
  const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return m ? (m[1] ?? m[2]) : undefined;
}

const missedUrls = new Set<string>();

/** Rebuild every media-host <img> in one HTML value; returns the count of
 *  tags whose rebuilt form differs. */
async function rewriteImgTags(
  html: string,
  mediaBase: string
): Promise<{ html: string; rewritten: number }> {
  let out = html;
  let rewritten = 0;

  const replacements = new Map<string, string>();
  for (const match of html.matchAll(/<img\b[^>]*\/?>/gi)) {
    const tag = match[0];
    if (replacements.has(tag)) continue;
    const src = getSrc(tag);
    if (!src || !src.startsWith(mediaBase)) continue;
    const record = await lookupFileByUrl(src);
    if (!record) {
      if (!missedUrls.has(src)) {
        missedUrls.add(src);
        logger.warn(`No files row for img src, tag left as-is: ${src.substring(0, 140)}`);
      }
      continue;
    }
    // A record without a rebuildable srcset (formats-less or dimension-less)
    // still gets its tag normalized — src/dims/alt survive, stale srcsets go.
    const rebuilt = rebuildImgTag(tag, record);
    if (rebuilt !== tag) replacements.set(tag, rebuilt);
  }
  for (const [oldTag, newTag] of replacements) {
    out = out.split(oldTag).join(newTag);
    rewritten++;
  }
  return { html: out, rewritten };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;

  const mediaBase = config.s3.baseUrl
    ? config.s3.baseUrl.replace(/\/+$/, "")
    : config.s3.bucket
      ? `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`
      : "";
  if (!mediaBase) {
    logger.error("Neither S3_BASE_URL nor S3_BUCKET is configured — cannot match img hosts");
    process.exitCode = 1;
    return;
  }

  logger.info(
    `fix-content-srcsets target host: ${host}, media base: ${mediaBase} ` +
      `(${apply ? "APPLY" : "dry-run"})`
  );
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply updates richtext columns on ${host}. ` +
        `Re-run with --yes-i-mean-${host} to confirm.`
    );
    process.exitCode = 1;
    return;
  }

  let totalChanged = 0;
  let totalTags = 0;
  for (const { table, column } of TARGETS) {
    const rows = await pgQuery<{ id: number; value: string }>(
      `SELECT id, ${column} AS value FROM ${table}
       WHERE ${column} LIKE '%<img%' AND ${column} LIKE '%' || $1 || '%'
       ORDER BY id`,
      [mediaBase]
    );

    for (const row of rows) {
      const { html: rewrittenRaw, rewritten } = await rewriteImgTags(
        row.value,
        mediaBase
      );
      if (rewritten === 0) continue;
      const converted = cleanHtml(rewrittenRaw);
      if (converted === row.value) continue;

      totalChanged += 1;
      totalTags += rewritten;
      logger.info(`--- ${table}.${column} id=${row.id} (${rewritten} img tag(s)) ---`);
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
    `${totalChanged} row(s) / ${totalTags} img tag(s) ` +
      `${apply ? "updated" : "would change (dry-run — pass --apply to write)"}, ` +
      `unresolved img srcs=${missedUrls.size}`
  );
}

main()
  .catch((err) => {
    logger.error(`fix-content-srcsets failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => closePg());
