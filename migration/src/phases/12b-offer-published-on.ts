import { pgQuery } from "../db/pg-client.js";
import { ensureMigrationRegistry } from "../utils/migration-registry.js";
import { logger } from "../utils/logger.js";

const OFFER_TABLES = ["coupons", "deals"] as const;

/**
 * Align the relevance timestamp with the WordPress PUBLISH date so imported
 * ordering matches the old site exactly (decision: pure publish-date order,
 * nothing pinned). `published_at` carries the WP post_date, so
 * migration-owned rows converge to `published_on = published_at`.
 *
 * WordPress remains authoritative while this migration is being run, so every
 * migration-owned row converges to the source publish date. Do not rerun the
 * migration after editors begin using Strapi's explicit bump action.
 */
export async function runOfferPublishedOnBackfill(): Promise<void> {
  await ensureMigrationRegistry();

  for (const table of OFFER_TABLES) {
    const updated = await pgQuery<{ id: number }>(
      `UPDATE "${table}" AS offer
          SET "published_on" = offer."published_at"
         FROM "migration_source_entities" AS registry
        WHERE registry."target_table" = $1
          AND registry."document_id" = offer."document_id"
          AND offer."published_at" IS NOT NULL
          AND offer."published_on" IS DISTINCT FROM offer."published_at"
        RETURNING offer."id"`,
      [table],
    );
    logger.info(
      `${table}: aligned published_on to the WordPress publish date for ` +
        `${updated.length} offer(s)`,
    );
  }
}
