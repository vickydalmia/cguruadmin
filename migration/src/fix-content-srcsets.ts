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

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
// rebuildImgTag composes the srcset via buildSrcset internally, and
// replaceImgTags is the same tag iterator the migration rewrite runs — all
// exported from content-media so this script and the migration cannot drift.
import { getAttr, rebuildImgTag, replaceImgTags } from "./utils/content-media.js";
import type { UploadedFileRecord } from "./phases/02-media-upload.js";
// Sanitizer + table/column targets shared with fix-markdown-richtext; the
// module throws at import on an unmapped uid, keeping this script's startup
// fail-fast (before any DB connection or the confirmation-flag check).
import { cleanHtml, RICHTEXT_TARGETS } from "./utils/richtext-targets.js";

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

const missedUrls = new Set<string>();

/** Rebuild every media-host <img> in one HTML value; returns the count of
 *  tags whose rebuilt form differs. */
async function rewriteImgTags(
  html: string,
  mediaBase: string
): Promise<{ html: string; rewritten: number }> {
  const { html: out, replacements } = await replaceImgTags(html, async (tag) => {
    const src = getAttr(tag, "src");
    if (!src || !src.startsWith(mediaBase)) return null;
    const record = await lookupFileByUrl(src);
    if (!record) {
      if (!missedUrls.has(src)) {
        missedUrls.add(src);
        logger.warn(`No files row for img src, tag left as-is: ${src.substring(0, 140)}`);
      }
      return null;
    }
    // A record without a rebuildable srcset (formats-less or dimension-less)
    // still gets its tag normalized — src/dims/alt survive, stale srcsets go.
    const rebuilt = rebuildImgTag(tag, record);
    return rebuilt !== tag ? rebuilt : null;
  });
  return { html: out, rewritten: replacements.size };
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
  for (const { table, column } of RICHTEXT_TARGETS) {
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
