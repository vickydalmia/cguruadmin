/**
 * Restores legacy KK Star Ratings aggregates from a CSV export after the
 * WordPress taxonomy was split into stores, brands, categories, and banks.
 *
 * The WordPress taxonomy ID is resolved through the deterministic document_id
 * created by Phase 03 (`term:${table}:${taxonomyId}`). Dry-run is the default.
 *
 * Store votes recorded after the Strapi cutover are preserved: the script
 * combines the recovered WordPress score/count with `store_rating_votes`.
 *
 *   yarn backfill:kksr-ratings --csv /absolute/path/to/export.csv
 *   yarn backfill:kksr-ratings --csv /absolute/path/to/export.csv \
 *     --apply --yes-i-mean-<host>
 */

import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { closePg, pgQuery, pgTransaction } from "./db/pg-client.js";
import { combineKksrWithNewVotes, readKksrCsv, type KksrRating } from "./utils/kksr-csv.js";
import { logger } from "./utils/logger.js";
import { generateDocumentId } from "./utils/strapi-insert.js";

const TABLES = ["stores", "brands", "categories", "banks"] as const;
type TaxonomyTable = (typeof TABLES)[number];

interface ResolvedRating extends KksrRating {
  id: number;
  table: TaxonomyTable;
  ratingAverage: number;
  ratingCount: number;
}

function argumentValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

async function resolveRatings(
  ratings: KksrRating[],
): Promise<{ resolved: ResolvedRating[]; unmatched: KksrRating[] }> {
  const matches = new Map<number, Array<{ id: number; table: TaxonomyTable }>>();
  const CHUNK = 1_000;

  for (const table of TABLES) {
    const documentToTaxonomy = new Map(
      ratings.map((rating) => [
        generateDocumentId(`term:${table}:${rating.taxonomyId}`),
        rating.taxonomyId,
      ]),
    );
    const documentIds = [...documentToTaxonomy.keys()];
    for (let index = 0; index < documentIds.length; index += CHUNK) {
      const chunk = documentIds.slice(index, index + CHUNK);
      const rows = await pgQuery<{ id: number; document_id: string }>(
        `SELECT id, document_id FROM "${table}" WHERE document_id = ANY($1::text[])`,
        [chunk],
      );
      for (const row of rows) {
        const taxonomyId = documentToTaxonomy.get(row.document_id)!;
        const existing = matches.get(taxonomyId) ?? [];
        existing.push({ id: row.id, table });
        matches.set(taxonomyId, existing);
      }
    }
  }

  const ambiguous = [...matches].filter(([, found]) => found.length > 1);
  if (ambiguous.length > 0) {
    const sample = ambiguous
      .slice(0, 10)
      .map(([id, found]) => `${id} (${found.map((item) => item.table).join(", ")})`)
      .join("; ");
    throw new Error(`taxonomy IDs resolve to multiple entity tables: ${sample}`);
  }

  const resolved: ResolvedRating[] = [];
  const unmatched: KksrRating[] = [];
  for (const rating of ratings) {
    const match = matches.get(rating.taxonomyId)?.[0];
    if (!match) {
      unmatched.push(rating);
      continue;
    }
    resolved.push({
      ...rating,
      ...match,
      ratingAverage: rating.average,
      ratingCount: rating.casts,
    });
  }

  if (await tableExists("store_rating_votes")) {
    const storeIds = resolved.filter((row) => row.table === "stores").map((row) => row.id);
    const votes = storeIds.length
      ? await pgQuery<{ store_id: number; vote_count: string; vote_score: string }>(
          `SELECT store_id, COUNT(*)::text AS vote_count, COALESCE(SUM(value), 0)::text AS vote_score
           FROM store_rating_votes
           WHERE store_id = ANY($1::int[])
           GROUP BY store_id`,
          [storeIds],
        )
      : [];
    const votesByStore = new Map(votes.map((vote) => [vote.store_id, vote]));
    for (const rating of resolved) {
      if (rating.table !== "stores") continue;
      const votesForStore = votesByStore.get(rating.id);
      const combined = combineKksrWithNewVotes(
        rating,
        Number(votesForStore?.vote_count ?? 0),
        Number(votesForStore?.vote_score ?? 0),
      );
      rating.ratingAverage = combined.ratingAverage;
      rating.ratingCount = combined.ratingCount;
    }
  }

  return { resolved, unmatched };
}

async function findChanges(rows: ResolvedRating[]): Promise<ResolvedRating[]> {
  const changed: ResolvedRating[] = [];
  for (const table of TABLES) {
    const tableRows = rows.filter((row) => row.table === table);
    if (tableRows.length === 0) continue;
    const current = await pgQuery<{
      id: number;
      rating_average: string | null;
      rating_count: number | null;
    }>(
      `SELECT id, rating_average, rating_count
       FROM "${table}"
       WHERE id = ANY($1::int[])`,
      [tableRows.map((row) => row.id)],
    );
    const currentById = new Map(current.map((row) => [row.id, row]));
    for (const row of tableRows) {
      const existing = currentById.get(row.id);
      if (
        !existing ||
        Number(existing.rating_average ?? 0) !== row.ratingAverage ||
        Number(existing.rating_count ?? 0) !== row.ratingCount
      ) {
        changed.push(row);
      }
    }
  }
  return changed;
}

async function applyChanges(rows: ResolvedRating[]): Promise<void> {
  const CHUNK = 500;
  await pgTransaction(async () => {
    for (const table of TABLES) {
      const tableRows = rows.filter((row) => row.table === table);
      for (let index = 0; index < tableRows.length; index += CHUNK) {
        const chunk = tableRows.slice(index, index + CHUNK);
        const values: string[] = [];
        const params: Array<number> = [];
        chunk.forEach((row, rowIndex) => {
          const offset = rowIndex * 3;
          values.push(`($${offset + 1}::int, $${offset + 2}::numeric, $${offset + 3}::int)`);
          params.push(row.id, row.ratingAverage, row.ratingCount);
        });
        await pgQuery(
          `UPDATE "${table}" AS entity SET
             rating_average = incoming.rating_average,
             rating_count = incoming.rating_count
           FROM (VALUES ${values.join(", ")})
             AS incoming(id, rating_average, rating_count)
           WHERE entity.id = incoming.id`,
          params,
        );
      }
    }
  });
}

export async function runKksrBackfill(
  csvPath: string,
  apply: boolean,
): Promise<void> {
  const ratings = readKksrCsv(csvPath);
  logger.info(`KKSR CSV: ${ratings.length} complete taxonomy rating(s)`);
  const { resolved, unmatched } = await resolveRatings(ratings);
  const byTable = new Map(TABLES.map((table) => [table, 0]));
  for (const row of resolved) byTable.set(row.table, byTable.get(row.table)! + 1);
  for (const table of TABLES) logger.info(`${table}: ${byTable.get(table)} mapped`);

  if (unmatched.length > 0) {
    const sample = unmatched
      .slice(0, 20)
      .map((row) => `${row.taxonomyId}:${row.taxonomySlug}`)
      .join(", ");
    logger.warn(`${unmatched.length} taxonomy ID(s) are not present in Strapi; sample: ${sample}`);
    logger.warn("Unmatched legacy taxonomies will be skipped; they will not be recreated.");
  }

  const changes = await findChanges(resolved);
  logger.info(`${changes.length} mapped row(s) ${apply ? "will be updated" : "would change"}`);
  if (apply && changes.length > 0) await applyChanges(changes);
  if (!apply) logger.info("Dry-run complete — no database rows changed.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvPath = argumentValue(args, "--csv");
  if (!csvPath) throw new Error("Missing required --csv /absolute/path/to/export.csv");
  const apply = args.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  logger.info(`backfill-kksr-ratings target host: ${host} (${apply ? "APPLY" : "dry-run"})`);
  if (apply && !args.includes(`--yes-i-mean-${host}`)) {
    throw new Error(
      `Refusing to write to ${host}; pass --apply --yes-i-mean-${host} to confirm.`,
    );
  }
  await runKksrBackfill(path.resolve(csvPath), apply);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main()
    .catch((error) => {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(closePg);
}
