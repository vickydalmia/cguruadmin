/**
 * Fill-only backfill for upload.file.backgroundColour.
 *
 * Source precedence is local bytes first (the migration source tree or local
 * provider file), followed by the smallest existing S3 responsive variant
 * (and finally the original). The script updates only NULL rows and never
 * writes to object storage.
 *
 *   yarn backfill:media-background-colours
 *   yarn backfill:media-background-colours --apply
 *   yarn backfill:media-background-colours --apply --limit=100
 *   yarn backfill:media-background-colours --apply --overwrite
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import { config } from "./config.js";
import {
  closePg,
  pgQuery,
  pgTransaction,
} from "./db/pg-client.js";
import {
  buildLocalHashMap,
  fetchFromS3,
  parseProviderMetadata,
  readLocalByHash,
} from "./phases/14-media-optimize.js";
import { getS3Client } from "./phases/02-media-upload.js";
import { logger } from "./utils/logger.js";

const { calculateImageBackgroundColour } = await import(
  "../../src/utils/image-background-colour.js"
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRAPI_PUBLIC_DIR = path.resolve(__dirname, "../../public");
const CONCURRENCY = 5;

interface CandidateRow {
  id: number;
  name: string;
  hash: string;
  ext: string | null;
  mime: string;
  url: string;
  provider: string;
  provider_metadata: unknown;
  formats: unknown;
}

interface Options {
  apply: boolean;
  limit: number | null;
  overwrite: boolean;
}

export function parseOptions(args: string[]): Options {
  const apply = args.includes("--apply");
  const overwrite = args.includes("--overwrite");
  if (apply && args.includes("--dry-run")) {
    throw new Error("--apply and --dry-run cannot be used together");
  }

  let limit: number | null = null;
  const equalsLimit = args.find((arg) => arg.startsWith("--limit="));
  const limitIndex = args.indexOf("--limit");
  const rawLimit =
    equalsLimit?.slice("--limit=".length) ??
    (limitIndex >= 0 ? args[limitIndex + 1] : undefined);
  if (rawLimit !== undefined) {
    if (!/^[1-9]\d*$/u.test(rawLimit)) {
      throw new Error("--limit must be a positive integer");
    }
    limit = Number(rawLimit);
  }

  const known = new Set([
    "--",
    "--apply",
    "--dry-run",
    "--limit",
    "--overwrite",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--limit=")) continue;
    if (known.has(arg)) {
      if (arg === "--limit") index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { apply, limit, overwrite };
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
}

function localProviderPath(row: CandidateRow): string | null {
  if (!row.url.startsWith("/uploads/")) return null;
  const candidate = path.resolve(
    STRAPI_PUBLIC_DIR,
    row.url.replace(/^\/+/u, ""),
  );
  const publicPrefix = `${STRAPI_PUBLIC_DIR}${path.sep}`;
  return candidate.startsWith(publicPrefix) ? candidate : null;
}

function keyFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    let pathname = decodeURIComponent(url.pathname);
    if (config.s3.baseUrl) {
      const base = new URL(config.s3.baseUrl);
      const basePath = base.pathname.replace(/\/+$/u, "");
      if (
        url.origin === base.origin &&
        basePath &&
        pathname.startsWith(`${basePath}/`)
      ) {
        pathname = pathname.slice(basePath.length);
      }
    }
    return pathname.replace(/^\/+/u, "") || null;
  } catch {
    return rawUrl.startsWith("/") ? rawUrl.replace(/^\/+/u, "") : null;
  }
}

function s3Key(row: CandidateRow): string | null {
  const metadata = parseProviderMetadata(row.provider_metadata);
  if (typeof metadata?.key === "string" && metadata.key) return metadata.key;

  const fromUrl = keyFromUrl(row.url);
  if (fromUrl) return fromUrl;

  const root = config.s3.rootPath ? `${config.s3.rootPath}/` : "";
  const stem = path.basename(row.name, path.extname(row.name));
  return row.hash ? `${root}${row.hash}_${stem}${row.ext ?? ""}` : null;
}

function parseFormats(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, any>;
  }
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function s3SourceKeys(row: CandidateRow): string[] {
  const variants = Object.values(parseFormats(row.formats))
    .filter((format: any) => typeof format?.url === "string")
    .sort((left: any, right: any) => {
      const leftArea =
        Number(left?.width || Number.MAX_SAFE_INTEGER) *
        Number(left?.height || Number.MAX_SAFE_INTEGER);
      const rightArea =
        Number(right?.width || Number.MAX_SAFE_INTEGER) *
        Number(right?.height || Number.MAX_SAFE_INTEGER);
      return leftArea - rightArea;
    })
    .map((format: any) => keyFromUrl(format.url))
    .filter((key): key is string => key !== null);
  const original = s3Key(row);
  return [...new Set([...variants, ...(original ? [original] : [])])];
}

async function sourceBytes(
  row: CandidateRow,
  localByHash: Map<string, string>,
): Promise<Buffer | null> {
  const metadata = parseProviderMetadata(row.provider_metadata);
  if (typeof metadata?.sourcePath === "string" && metadata.sourcePath) {
    const direct = await readFileOrNull(path.resolve(metadata.sourcePath));
    if (direct) return direct;
  }

  const migratedSource = await readLocalByHash(localByHash, row.hash);
  if (migratedSource) return migratedSource;

  if (row.provider === "local") {
    const localPath = localProviderPath(row);
    return localPath ? readFileOrNull(localPath) : null;
  }

  if (
    row.provider === "aws-s3" &&
    config.s3.bucket &&
    config.s3.accessKeyId
  ) {
    for (const key of s3SourceKeys(row)) {
      const bytes = await fetchFromS3(getS3Client(), key);
      if (bytes) return bytes;
    }
  }

  return null;
}

async function candidates(
  limit: number | null,
  overwrite: boolean,
): Promise<CandidateRow[]> {
  const params: unknown[] = [];
  const limitSql = limit
    ? (() => {
        params.push(limit);
        return ` LIMIT $${params.length}`;
      })()
    : "";

  return pgQuery<CandidateRow>(
    `SELECT id, name, hash, ext, mime, url, provider, provider_metadata, formats
     FROM files
     WHERE mime LIKE 'image/%'
       ${overwrite ? "" : "AND background_colour IS NULL"}
     ORDER BY id${limitSql}`,
    params,
  );
}

export async function runMediaBackgroundColourBackfill(
  options: Options,
): Promise<void> {
  const rows = await candidates(options.limit, options.overwrite);
  logger.info(
    `Media background colours: ${rows.length} candidate(s)` +
      (options.limit ? ` (limit ${options.limit})` : "") +
      (options.overwrite ? " (overwriting existing colours)" : ""),
  );

  if (!options.apply) {
    logger.info("Dry run only. Pass --apply to calculate and persist colours.");
    return;
  }
  if (rows.length === 0) return;

  logger.info("Preparing local media source lookup (S3 remains the fallback)...");
  const localByHash = buildLocalHashMap();
  const limit = pLimit(CONCURRENCY);
  const progressEvery = Math.max(1, Math.min(100, Math.ceil(rows.length / 20)));
  let processed = 0;
  let calculatedCount = 0;
  logger.info(
    `Calculating colours with concurrency=${CONCURRENCY}; progress logs every ${progressEvery} image(s)`,
  );
  const calculated = (
    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          try {
            const bytes = await sourceBytes(row, localByHash);
            if (!bytes) {
              logger.warn(`No readable source for media ${row.id} (${row.name})`);
              return null;
            }
            const result = {
              id: row.id,
              colour: await calculateImageBackgroundColour(bytes),
            };
            calculatedCount++;
            return result;
          } catch (error: any) {
            logger.warn(
              `Could not calculate media ${row.id} (${row.name}): ${error.message}`,
            );
            return null;
          } finally {
            processed++;
            if (processed % progressEvery === 0 || processed === rows.length) {
              logger.info(
                `Colour progress: ${processed}/${rows.length} ` +
                  `(${Math.round((processed / rows.length) * 100)}%) — ` +
                  `calculated=${calculatedCount}, unresolved=${processed - calculatedCount}`,
              );
            }
          }
        }),
      ),
    )
  ).filter(
    (entry): entry is { id: number; colour: string } => entry !== null,
  );

  if (calculated.length === 0) {
    logger.warn("No media colours could be calculated; no rows were changed.");
    return;
  }

  const updated = await pgTransaction(async () => {
    const updatedIds: number[] = [];
    logger.info(`Saving ${calculated.length} calculated colour(s) to Postgres...`);
    for (const [index, entry] of calculated.entries()) {
      const result = await pgQuery<{ id: number }>(
        `UPDATE files
         SET background_colour = $1, updated_at = NOW()
         WHERE id = $2
           ${options.overwrite ? "" : "AND background_colour IS NULL"}
         RETURNING id`,
        [entry.colour, entry.id],
      );
      if (result[0]) updatedIds.push(result[0].id);
      const saved = index + 1;
      if (saved % progressEvery === 0 || saved === calculated.length) {
        logger.info(
          `Database progress: ${saved}/${calculated.length} ` +
            `(${Math.round((saved / calculated.length) * 100)}%)`,
        );
      }
    }

    if (updatedIds.length > 0) {
      const [{ table_name: outboxTable }] = await pgQuery<{
        table_name: string | null;
      }>(`SELECT to_regclass('public.isr_outbox')::text AS table_name`);
      if (!outboxTable) {
        throw new Error(
          "isr_outbox is missing; run Strapi database migrations before this backfill",
        );
      }
      await pgQuery(
        `INSERT INTO isr_outbox (
           event_key, payload, reason, status, attempt_count,
           next_attempt_at, created_at
         ) VALUES ($1, $2::jsonb, $3, 'pending', 0, NOW(), NOW())`,
        [
          crypto.randomUUID(),
          JSON.stringify({ all: true }),
          "Media background colour backfill",
        ],
      );
    }
    return updatedIds.length;
  });

  logger.info(
    `Media background colour backfill complete: updated=${updated}, ` +
      `unresolved=${rows.length - calculated.length}`,
  );
  if (updated > 0) {
    logger.info("Queued one full ISR invalidation in isr_outbox.");
  }
}

async function main(): Promise<void> {
  try {
    await runMediaBackgroundColourBackfill(parseOptions(process.argv.slice(2)));
  } finally {
    await closePg();
  }
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
