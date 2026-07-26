import { pgQuery } from "../db/pg-client.js";
import { ensureMigrationRegistry } from "../utils/migration-registry.js";
import { logger } from "../utils/logger.js";

const OFFER_TABLES = ["coupons", "deals"] as const;

/**
 * Correct legacy migration rows that seeded the relevance timestamp from the
 * original publication date. Rows whose published_on already differs from
 * published_at are preserved because that difference represents an editorial
 * bump made after migration.
 */
export async function runOfferPublishedOnBackfill(): Promise<void> {
  await ensureMigrationRegistry();

  for (const table of OFFER_TABLES) {
    const updated = await pgQuery<{ id: number }>(
      `UPDATE "${table}" AS offer
          SET "published_on" = offer."updated_at"
         FROM "migration_source_entities" AS registry
        WHERE registry."target_table" = $1
          AND registry."document_id" = offer."document_id"
          AND offer."published_at" IS NOT NULL
          AND offer."updated_at" IS NOT NULL
          AND (
            offer."published_on" IS NULL
            OR offer."published_on" IS NOT DISTINCT FROM offer."published_at"
          )
        RETURNING offer."id"`,
      [table],
    );
    logger.info(
      `${table}: set published_on from the migrated WordPress modification ` +
        `date for ${updated.length} offer(s)`,
    );
  }
}
