/**
 * Fill missing Store/Brand/Category/Bank long descriptions from the current
 * WordPress category-taxonomy description.
 *
 * The backfill is deliberately fill-only: an existing Strapi description is
 * editor-owned and is never overwritten. WordPress HTML goes through the same
 * sanitizer and embedded-media rewrite as Phase 03, including media morph
 * links. Dry-run is the default.
 *
 *   yarn backfill:taxonomy-descriptions
 *   yarn backfill:taxonomy-descriptions --apply --yes-i-mean-<pg-host>
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { closePg, pgQuery, pgTransaction } from "./db/pg-client.js";
import { closeWp, wpQuery } from "./db/wp-client.js";
import { rewriteContentMedia, logContentMediaStats } from "./utils/content-media.js";
import {
  loadExcludedStoreNames,
  resolveImportExclusions,
} from "./utils/import-exclusions.js";
import { logger } from "./utils/logger.js";
import { replaceContentMedia } from "./utils/strapi-insert.js";
import {
  TAXONOMY_DESCRIPTION_TARGETS,
  auditTaxonomyDescriptionCoverage,
  parseTaxonomyDescriptionBackfillOptions,
  type StrapiTaxonomyDescriptionRow,
  type TaxonomyDescriptionGap,
  type WpTaxonomyDescriptionRow,
} from "./utils/taxonomy-description-backfill.js";

const TABLES = Object.values(TAXONOMY_DESCRIPTION_TARGETS).map(
  ({ table }) => table,
);

async function loadWordPressTerms(): Promise<WpTaxonomyDescriptionRow[]> {
  return wpQuery<WpTaxonomyDescriptionRow>(`
    SELECT
      t.term_id,
      t.name,
      t.slug,
      tt.parent,
      tt.description,
      MAX(CASE WHEN tm.meta_key = 'choose_type' THEN tm.meta_value END) AS choose_type
    FROM wp_terms t
    JOIN wp_term_taxonomy tt
      ON tt.term_id = t.term_id AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm
      ON tm.term_id = t.term_id AND tm.meta_key = 'choose_type'
    GROUP BY t.term_id, t.name, t.slug, tt.parent, tt.description
    ORDER BY t.term_id
  `);
}

async function loadStrapiTerms(): Promise<StrapiTaxonomyDescriptionRow[]> {
  const groups = await Promise.all(
    TABLES.map(async (table) => {
      const rows = await pgQuery<Omit<StrapiTaxonomyDescriptionRow, "table">>(
        `SELECT id, document_id, name, description FROM "${table}"`,
      );
      return rows.map((row) => ({ ...row, table }));
    }),
  );
  return groups.flat();
}

function logCoverage(
  expected: number,
  present: number,
  gaps: readonly TaxonomyDescriptionGap[],
): void {
  const missingEntities = gaps.filter(
    ({ reason }) => reason === "missing-entity",
  );
  const blankDescriptions = gaps.filter(
    ({ reason }) => reason === "blank-description",
  );
  logger.info(
    `Taxonomy long descriptions: ${present}/${expected} already present, ` +
      `${blankDescriptions.length} blank target(s), ` +
      `${missingEntities.length} missing target entit${
        missingEntities.length === 1 ? "y" : "ies"
      }`,
  );
  for (const gap of gaps.slice(0, 30)) {
    logger.info(
      `  ${gap.table}/${gap.name} (WP term ${gap.termId}): ${
        gap.reason === "blank-description" ? "would fill" : "entity missing"
      }`,
    );
  }
  if (gaps.length > 30) {
    logger.info(`  ...and ${gaps.length - 30} more gap(s)`);
  }
}

async function fillDescription(gap: TaxonomyDescriptionGap): Promise<boolean> {
  if (gap.entityId === null || gap.reason !== "blank-description") return false;

  const rewritten = await rewriteContentMedia(gap.sanitizedDescription);
  if (!rewritten.html) {
    throw new Error(`sanitized description became blank for WP term ${gap.termId}`);
  }

  let updated = false;
  await pgTransaction(async () => {
    // Recheck the fill-only predicate inside the write transaction. If an
    // editor populated the field after the dry run, their copy wins.
    const rows = await pgQuery<{ id: number }>(
      `UPDATE "${gap.table}"
          SET description = $1,
              updated_at = NOW()
        WHERE id = $2
          AND (description IS NULL OR BTRIM(description) = '')
      RETURNING id`,
      [rewritten.html, gap.entityId],
    );
    if (!rows[0]) return;

    await replaceContentMedia(
      rewritten.fileIds,
      gap.entityId!,
      gap.type,
      "description",
    );
    updated = true;
  });
  return updated;
}

export async function runTaxonomyDescriptionBackfill(
  apply: boolean,
): Promise<void> {
  const sourceRows = await loadWordPressTerms();
  const exclusions = resolveImportExclusions(
    sourceRows,
    loadExcludedStoreNames(),
  );
  const initial = auditTaxonomyDescriptionCoverage(
    sourceRows,
    await loadStrapiTerms(),
    exclusions.termIds,
  );
  logCoverage(initial.expected, initial.present, initial.gaps);

  const candidates = initial.gaps.filter(
    (gap) => gap.reason === "blank-description",
  );
  if (!apply) {
    logger.info(
      `Dry-run complete — ${candidates.length} description(s) would be filled; ` +
        "no database or media changes were made.",
    );
    return;
  }

  let updated = 0;
  const failures: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      if (await fillDescription(candidate)) updated++;
      logger.info(
        `Description backfill progress: ${index + 1}/${candidates.length} ` +
          `(updated=${updated}, failed=${failures.length})`,
      );
    } catch (error: any) {
      const message = `${candidate.table}/${candidate.name}: ${
        error?.message ?? String(error)
      }`;
      failures.push(message);
      logger.error(message);
    }
  }
  logContentMediaStats();

  const finalCoverage = auditTaxonomyDescriptionCoverage(
    sourceRows,
    await loadStrapiTerms(),
    exclusions.termIds,
  );
  const remainingBlank = finalCoverage.gaps.filter(
    ({ reason }) => reason === "blank-description",
  );
  logger.info(
    `Taxonomy description backfill applied: ${updated} updated, ` +
      `${remainingBlank.length} blank target(s) remain, ` +
      `${failures.length} failure(s).`,
  );

  if (remainingBlank.length > 0 || failures.length > 0) {
    throw new Error(
      `Description backfill incomplete: ${remainingBlank.length} blank target(s), ` +
        `${failures.length} failure(s). Re-run safely after resolving the logged errors.`,
    );
  }
}

async function main(): Promise<void> {
  const host = new URL(config.pg.connectionString).hostname;
  const options = parseTaxonomyDescriptionBackfillOptions(
    process.argv.slice(2),
    host,
  );
  logger.info(
    `backfill-taxonomy-descriptions target host: ${host} ` +
      `(${options.apply ? "APPLY" : "dry-run"})`,
  );
  await runTaxonomyDescriptionBackfill(options.apply);
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
