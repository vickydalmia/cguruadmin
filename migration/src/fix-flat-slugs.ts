import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { wpQuery, closeWp } from "./db/wp-client.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { loadMaps, getAllTermMappings } from "./utils/id-maps.js";
import { cleanSlug } from "./utils/sanitize.js";
import { logger } from "./utils/logger.js";

/**
 * Sync entity slugs VERBATIM from WordPress: for every imported
 * store/brand/category/bank, set the Strapi slug to the WP term's slug
 * (character-sanitized only — no joining, no suffixing, no rewriting).
 * Mismatches whose target slug is already taken by another row are skipped
 * loudly for a human decision.
 *
 *   yarn fix:wp-slugs                              # dry run (default)
 *   yarn fix:wp-slugs --apply --yes-i-mean-<host>  # write
 */

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply rewrites entity slugs on ${host}. ` +
        `Re-run with --apply --yes-i-mean-${host} to confirm.`,
    );
    process.exitCode = 1;
    return;
  }

  loadMaps();
  const termMappings = getAllTermMappings();
  if (termMappings.size === 0) {
    throw new Error(
      "No term mappings found (.checkpoints/termIdMap.json) — run the " +
        "migration first; this script repairs already-imported entities.",
    );
  }

  const wpTerms = await wpQuery<{ term_id: number; slug: string }>(`
    SELECT t.term_id, t.slug
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'category'
  `);
  const wpSlugByTermId = new Map(wpTerms.map((t) => [t.term_id, t.slug]));

  // Current slugs per table, and a per-table occupancy set for collisions.
  const tables = ["stores", "brands", "categories", "banks"] as const;
  const currentByTable = new Map<string, Map<number, { name: string; slug: string }>>();
  const takenByTable = new Map<string, Set<string>>();
  for (const table of tables) {
    const rows = await pgQuery<{ id: number; name: string; slug: string }>(
      `SELECT id, name, slug FROM "${table}"`,
    );
    currentByTable.set(table, new Map(rows.map((r) => [r.id, r])));
    takenByTable.set(table, new Set(rows.map((r) => r.slug)));
  }

  let checked = 0;
  let changed = 0;
  let collisions = 0;
  let missingWp = 0;
  const samples: string[] = [];

  for (const [wpTermId, ref] of termMappings) {
    if (!tables.includes(ref.table as any)) continue;
    const current = currentByTable.get(ref.table)?.get(ref.id);
    if (!current) continue;
    checked++;

    const wpSlug = wpSlugByTermId.get(wpTermId);
    if (!wpSlug) {
      missingWp++;
      continue;
    }
    const expected = cleanSlug(wpSlug) || wpSlug;
    if (current.slug === expected) continue;

    const taken = takenByTable.get(ref.table)!;
    if (taken.has(expected)) {
      collisions++;
      logger.warn(
        `${ref.table}/${current.name}: COLLISION — "${current.slug}" → ` +
          `"${expected}" is already taken; left unchanged, resolve manually`,
      );
      continue;
    }

    changed++;
    if (samples.length < 15) {
      samples.push(
        `${ref.table}/${current.name}: "${current.slug}" → "${expected}"`,
      );
    }
    if (apply) {
      await pgQuery(`UPDATE "${ref.table}" SET slug = $1 WHERE id = $2`, [
        expected,
        ref.id,
      ]);
      taken.delete(current.slug);
      taken.add(expected);
    }
  }

  for (const sample of samples) logger.info(`  ${sample}`);
  logger.info(
    `Slug sync ${apply ? "APPLIED" : "dry-run"}: ${checked} checked, ` +
      `${changed} ${apply ? "updated" : "to update"}, ` +
      `${collisions} collision(s) skipped, ${missingWp} without a WP term`,
  );
  if (!apply && changed > 0) {
    logger.info(`Pass --apply --yes-i-mean-${host} to write.`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main()
    .catch((error) => {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeWp();
      await closePg();
    });
}
