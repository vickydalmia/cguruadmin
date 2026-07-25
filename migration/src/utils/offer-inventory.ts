import { pgQuery, pgTransaction } from "../db/pg-client.js";
import { logger } from "./logger.js";
import {
  ensureMigrationRegistry,
  migrationRegistryRows,
} from "./migration-registry.js";

export type MigratedOfferTable = "coupons" | "deals";

type MigratedOfferRow = {
  id: number | null;
  document_id: string;
};

const OFFER_UID: Record<MigratedOfferTable, string> = {
  coupons: "api::coupon.coupon",
  deals: "api::deal.deal",
};

export function staleMigratedOfferRows(
  rows: readonly MigratedOfferRow[],
  expectedDocumentIds: ReadonlySet<string>,
): MigratedOfferRow[] {
  return rows.filter((row) => !expectedDocumentIds.has(row.document_id));
}

/**
 * Remove registry-owned rows that no longer belong to this source partition.
 *
 * This makes re-import converge when a post is withdrawn, deleted, or changes
 * between Coupon and Product Deal. Hand-created Strapi rows are preserved.
 */
export async function reconcileMigratedOfferInventory(
  table: MigratedOfferTable,
  expectedDocumentIds: ReadonlySet<string>,
): Promise<number> {
  await ensureMigrationRegistry();
  const existing = await pgQuery<MigratedOfferRow>(
    `SELECT entity."id", registry."document_id"
     FROM "migration_source_entities" registry
     LEFT JOIN "${table}" entity
       ON entity."document_id" = registry."document_id"
     WHERE registry."target_table" = $1`,
    [table],
  );
  const stale = staleMigratedOfferRows(existing, expectedDocumentIds);
  if (stale.length === 0) return 0;

  const staleIds = stale
    .map((row) => row.id)
    .filter((id): id is number => id !== null);
  const staleDocumentIds = stale.map((row) => row.document_id);
  await pgTransaction(async () => {
    // Strapi's relation link tables cascade with the entity. Its polymorphic
    // media table has no entity foreign key, so remove those rows explicitly.
    if (staleIds.length > 0) {
      await pgQuery(
        `DELETE FROM "files_related_mph"
         WHERE "related_type" = $1 AND "related_id" = ANY($2::int[])`,
        [OFFER_UID[table], staleIds],
      );
      await pgQuery(
        `DELETE FROM "${table}" WHERE "id" = ANY($1::int[])`,
        [staleIds],
      );
    }
    await pgQuery(
      `DELETE FROM "migration_source_entities"
       WHERE "document_id" = ANY($1::text[])`,
      [staleDocumentIds],
    );
  });

  logger.info(
    `Removed ${stale.length} withdrawn/reclassified migrated ${table}`,
  );
  return stale.length;
}
