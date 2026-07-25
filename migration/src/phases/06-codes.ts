import { createRequire } from "node:module";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import { getPoolMapping } from "../utils/id-maps.js";
import { generateDocumentId } from "../utils/strapi-insert.js";
import { config } from "../config.js";
import { cleanCode } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";
import {
  collapseBatchDuplicateCodes,
  type PreparedUniqueCode,
} from "../utils/unique-code-import.js";

const MAX_CODE_BATCH_SIZE = 10_000;
const POSTGRES_PARAMETER_LIMIT = 65_535;

type LookupIndexDefinition = {
  name: string;
  table: string;
  columns: readonly string[];
};

const require = createRequire(import.meta.url);
const {
  POSTGRES_LOOKUP_INDEXES,
  postgresLookupIndexSql,
}: {
  POSTGRES_LOOKUP_INDEXES: readonly LookupIndexDefinition[];
  postgresLookupIndexSql: (index: LookupIndexDefinition) => string;
} = require("../../../database/unique-code-integrity.js");

export async function runCodes(): Promise<void> {
  logger.info("=== Phase 6: Unique Codes Migration ===");

  // Check if wp_uc_codes exists
  const tableCheck = await wpQuery<{ c: number }>(`
    SELECT COUNT(*) AS c
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'wp_uc_codes'
  `);

  if (!tableCheck[0]?.c) {
    logger.warn("wp_uc_codes table not found. Skipping codes migration.");
    return;
  }

  // Phase-only resumes must not depend on a separate Strapi bootstrap having
  // installed these indexes. They turn the live duplicate guard's per-link
  // lookup from a pool scan into an indexed (code, pool) probe.
  for (const index of POSTGRES_LOOKUP_INDEXES) {
    await pgQuery(postgresLookupIndexSql(index));
  }

  const [totalCount] = await wpQuery<{ c: number }>(
    "SELECT COUNT(*) AS c FROM wp_uc_codes"
  );
  const total = totalCount.c as number;
  logger.info(`Total unique codes to migrate: ${total}`);

  const requestedBatchSize = Number.isFinite(config.batchSize)
    ? Math.max(1, Math.trunc(config.batchSize))
    : 5_000;
  const batchSize = Math.min(requestedBatchSize, MAX_CODE_BATCH_SIZE);
  if (requestedBatchSize > MAX_CODE_BATCH_SIZE) {
    logger.warn(
      `BATCH_SIZE ${requestedBatchSize} exceeds the safe Phase 6 limit; ` +
        `using ${MAX_CODE_BATCH_SIZE}`,
    );
  }
  let lastSeenId = 0;
  let processedTotal = 0;
  let writtenTotal = 0;
  let duplicateTotal = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const codes = await wpQuery<{
      id: number;
      coupon_id: number;
      code: string;
      is_used: number;
      version: number;
    }>(`
      SELECT id, coupon_id, code, is_used, version
      FROM wp_uc_codes
      WHERE id > ?
      ORDER BY id
      LIMIT ${batchSize}
    `, [lastSeenId]);

    if (codes.length === 0) break;

    const prepared = codes.map<PreparedUniqueCode>((code) => ({
      wpId: code.id,
      targetPoolId: getPoolMapping(code.coupon_id)?.id ?? null,
      documentId: generateDocumentId(`unique-code:${code.id}`),
      code: cleanCode(code.code) || code.code,
      isUsed: code.is_used === 1,
      version: code.version || 0,
    }));
    const collapsed = collapseBatchDuplicateCodes(prepared);

    try {
      const written = await pgTransaction(async () => {
        const pooled = collapsed.rows
          .map((code, sourceIndex) => ({ code, sourceIndex }))
          .filter(({ code }) => code.targetPoolId !== null);
        const existingBySourceIndex = new Map<
          number,
          { id: number; documentId: string | null }
        >();

        // A duplicate can occur in a later WordPress batch. Resolve an
        // already-linked equal (pool, code) before inserting another row so
        // the live database trigger never has to reject the import.
        if (pooled.length > 0) {
          const matchValues: any[] = [];
          let matchIdx = 1;
          const matchPlaceholders = pooled.map(({ code, sourceIndex }) => {
            matchValues.push(sourceIndex, code.targetPoolId, code.code);
            return (
              `($${matchIdx++}::integer, $${matchIdx++}::bigint, ` +
              `$${matchIdx++}::text)`
            );
          });
          const matches = await pgQuery<{
            source_index: number;
            id: number;
            document_id: string | null;
          }>(
            `SELECT
               desired.source_index,
               existing_code.id,
               existing_code.document_id
             FROM (VALUES ${matchPlaceholders.join(", ")}) AS desired(
               source_index, pool_id, code
             )
             JOIN "unique_codes_pool_lnk" AS existing_link
               ON existing_link."unique_coupon_pool_id" = desired.pool_id
             JOIN "unique_codes" AS existing_code
               ON existing_code.id = existing_link."unique_code_id"
              AND existing_code.code = desired.code`,
            matchValues,
          );
          for (const match of matches) {
            existingBySourceIndex.set(Number(match.source_index), {
              id: Number(match.id),
              documentId: match.document_id,
            });
          }
        }

        const matched = collapsed.rows
          .map((code, sourceIndex) => ({
            code,
            existing: existingBySourceIndex.get(sourceIndex),
          }))
          .filter(
            (
              item,
            ): item is {
              code: PreparedUniqueCode;
              existing: { id: number; documentId: string | null };
            } => Boolean(item.existing),
          );

        let mergedExistingCount = 0;
        if (matched.length > 0) {
          const matchedKeeperIds = [
            ...new Set(matched.map(({ existing }) => existing.id)),
          ];
          const matchedSourceDocumentIds = [
            ...new Set(matched.map(({ code }) => code.documentId)),
          ];

          // Lock both sides before reading redemption state. Otherwise a
          // redemption could commit after the keeper merge but before the
          // duplicate DELETE, causing a newly-used source row to disappear.
          await pgQuery(
            `SELECT "id"
               FROM "unique_codes"
              WHERE "id" = ANY($1::bigint[])
                 OR "document_id" = ANY($2::text[])
              FOR UPDATE`,
            [matchedKeeperIds, matchedSourceDocumentIds],
          );

          const mergeValues: any[] = [];
          let mergeIdx = 1;
          const mergePlaceholders = matched.map(({ code, existing }) => {
            mergeValues.push(
              existing.id,
              code.documentId,
              code.isUsed,
              code.version,
            );
            return (
              `($${mergeIdx++}::bigint, $${mergeIdx++}::text, ` +
              `$${mergeIdx++}::boolean, $${mergeIdx++}::integer)`
            );
          });
          const merged = await pgQuery<{ id: number }>(
            `WITH desired(
               keeper_id, source_document_id, source_is_used, source_version
             ) AS (
               VALUES ${mergePlaceholders.join(", ")}
             ),
             merge_source AS (
               SELECT
                 desired.keeper_id,
                 desired.source_is_used OR
                   COALESCE(duplicate."is_used", false) AS is_used,
                 CASE
                   WHEN COALESCE(duplicate."is_used", false)
                     THEN duplicate."used_at"
                   ELSE NULL
                 END AS used_at,
                 GREATEST(
                   desired.source_version,
                   COALESCE(duplicate."version", 0)
                 ) AS version
               FROM desired
               LEFT JOIN "unique_codes" AS duplicate
                 ON duplicate."document_id" = desired.source_document_id
                AND duplicate."id" <> desired.keeper_id
             )
             UPDATE "unique_codes" AS existing
                SET "is_used" = existing."is_used" OR merge_source.is_used,
                    "used_at" = CASE
                      WHEN existing."used_at" IS NULL
                        THEN merge_source.used_at
                      WHEN merge_source.used_at IS NULL
                        THEN existing."used_at"
                      ELSE LEAST(existing."used_at", merge_source.used_at)
                    END,
                    "version" = GREATEST(
                      existing."version",
                      merge_source.version
                    ),
                    "updated_at" = NOW()
               FROM merge_source
              WHERE existing.id = merge_source.keeper_id
                AND (
                  existing."is_used",
                  existing."used_at",
                  existing."version"
                )
                    IS DISTINCT FROM (
                      existing."is_used" OR merge_source.is_used,
                      CASE
                        WHEN existing."used_at" IS NULL
                          THEN merge_source.used_at
                        WHEN merge_source.used_at IS NULL
                          THEN existing."used_at"
                        ELSE LEAST(existing."used_at", merge_source.used_at)
                      END,
                      GREATEST(existing."version", merge_source.version)
                    )
              RETURNING existing.id`,
            mergeValues,
          );
          mergedExistingCount = merged.length;

          const duplicateDocuments = matched.filter(
            ({ code, existing }) =>
              existing.documentId !== code.documentId,
          );
          if (duplicateDocuments.length > 0) {
            const deleteValues: any[] = [];
            let deleteIdx = 1;
            const deletePlaceholders = duplicateDocuments.map(
              ({ code, existing }) => {
                deleteValues.push(code.documentId, existing.id);
                return `($${deleteIdx++}::text, $${deleteIdx++}::bigint)`;
              },
            );
            await pgQuery(
              `DELETE FROM "unique_codes" AS duplicate
               USING (VALUES ${deletePlaceholders.join(", ")}) AS keeper(
                 document_id, id
               )
               WHERE duplicate.document_id = keeper.document_id
                 AND duplicate.id <> keeper.id`,
              deleteValues,
            );
          }
        }

        const unmatched = collapsed.rows.filter(
          (_code, sourceIndex) => !existingBySourceIndex.has(sourceIndex),
        );
        const unmatchedDocumentIds = unmatched.map((code) => code.documentId);
        const desiredPoolByDocumentId = new Map(
          unmatched.map((code) => [code.documentId, code.targetPoolId]),
        );

        // Resolve and lock source-owned rows before changing their guarded code
        // value. A code moving from pool A to pool B must be unlinked from A
        // first; otherwise the value-update trigger validates a transient state
        // that is not the intended final ownership and can reject a valid move.
        const existingSourceRows =
          unmatchedDocumentIds.length > 0
            ? await pgQuery<{ id: number; document_id: string }>(
                `SELECT "id", "document_id"
                   FROM "unique_codes"
                  WHERE "document_id" = ANY($1::text[])
                  FOR UPDATE`,
                [unmatchedDocumentIds],
              )
            : [];
        if (existingSourceRows.length > 0) {
          const unlinkValues: any[] = [];
          let unlinkIdx = 1;
          const unlinkPlaceholders = existingSourceRows.map((row) => {
            unlinkValues.push(
              row.id,
              desiredPoolByDocumentId.get(row.document_id) ?? null,
            );
            return `($${unlinkIdx++}::bigint, $${unlinkIdx++}::bigint)`;
          });
          await pgQuery(
            `DELETE FROM "unique_codes_pool_lnk" AS existing_link
             USING (VALUES ${unlinkPlaceholders.join(", ")}) AS desired(
               unique_code_id, unique_coupon_pool_id
             )
             WHERE existing_link."unique_code_id" = desired.unique_code_id
               AND (
                 desired.unique_coupon_pool_id IS NULL
                 OR existing_link."unique_coupon_pool_id" <>
                    desired.unique_coupon_pool_id
               )`,
            unlinkValues,
          );
        }

        const values: any[] = [];
        const valuePlaceholders: string[] = [];
        const documentIds: string[] = [];
        let paramIdx = 1;
        for (const code of unmatched) {
          documentIds.push(code.documentId);
          valuePlaceholders.push(
            `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
              `$${paramIdx++}, NOW(), NOW(), NOW(), $${paramIdx++})`,
          );
          values.push(
            code.documentId,
            code.code,
            code.isUsed,
            code.version,
            null,
          );
        }

        let changedRows: Array<{
          id: number;
          document_id: string;
          code: string;
        }> = [];
        if (unmatched.length > 0) {
          changedRows = await pgQuery<{
            id: number;
            document_id: string;
            code: string;
          }>(
            `INSERT INTO "unique_codes" (
               "document_id", "code", "is_used", "version",
               "created_at", "updated_at", "published_at", "locale"
             )
             VALUES ${valuePlaceholders.join(", ")}
             ON CONFLICT ("document_id") DO UPDATE SET
               "code" = CASE
                 WHEN "unique_codes"."is_used" THEN "unique_codes"."code"
                 ELSE EXCLUDED."code"
               END,
               "is_used" = "unique_codes"."is_used" OR EXCLUDED."is_used",
               "version" = GREATEST("unique_codes"."version", EXCLUDED."version"),
               "updated_at" = NOW()
             WHERE (
               "unique_codes"."code",
               "unique_codes"."is_used",
               "unique_codes"."version"
             ) IS DISTINCT FROM (
               CASE
                 WHEN "unique_codes"."is_used" THEN "unique_codes"."code"
                 ELSE EXCLUDED."code"
               END,
               "unique_codes"."is_used" OR EXCLUDED."is_used",
               GREATEST("unique_codes"."version", EXCLUDED."version")
             )
             RETURNING id, document_id, code`,
            values,
          );
        }

        const resolvedRows =
          documentIds.length > 0
            ? await pgQuery<{
                id: number;
                document_id: string;
              }>(
                `SELECT id, document_id
                   FROM "unique_codes"
                  WHERE document_id = ANY($1::text[])`,
                [documentIds],
              )
            : [];
        const codeIdByDocumentId = new Map(
          resolvedRows.map((row) => [row.document_id, row.id]),
        );

        const desiredLinks: Array<[number, number, number]> = [];
        for (let i = 0; i < unmatched.length; i++) {
          const uniqueCodeId = codeIdByDocumentId.get(documentIds[i]);
          const targetPoolId = unmatched[i].targetPoolId;
          if (uniqueCodeId && targetPoolId !== null) {
            desiredLinks.push([uniqueCodeId, targetPoolId, 1]);
          }
        }

        // Re-import convergence: move a code away from a stale pool inside
        // the same transaction, then insert only genuinely missing links.
        // Filtering before INSERT avoids firing the duplicate guard trigger
        // once per unchanged code on every re-import.
        const linkBatchSize =
          Math.floor(POSTGRES_PARAMETER_LIMIT / 3) - 1;
        for (let start = 0; start < desiredLinks.length; start += linkBatchSize) {
          const chunk = desiredLinks.slice(start, start + linkBatchSize);
          const linkValues = chunk.flat();
          let linkIdx = 1;
          const linkPlaceholders = chunk.map(
            () =>
              `($${linkIdx++}::bigint, $${linkIdx++}::bigint, ` +
              `$${linkIdx++}::integer)`,
          );
          const desiredValues = linkPlaceholders.join(", ");

          await pgQuery(
            `DELETE FROM "unique_codes_pool_lnk" AS existing
             USING (VALUES ${desiredValues}) AS desired(
               unique_code_id, unique_coupon_pool_id, unique_code_ord
             )
             WHERE existing."unique_code_id" = desired.unique_code_id
               AND existing."unique_coupon_pool_id" <>
                   desired.unique_coupon_pool_id`,
            linkValues,
          );
          await pgQuery(
            `INSERT INTO "unique_codes_pool_lnk" (
               "unique_code_id", "unique_coupon_pool_id", "unique_code_ord"
             )
             SELECT
               desired.unique_code_id,
               desired.unique_coupon_pool_id,
               desired.unique_code_ord
             FROM (VALUES ${desiredValues}) AS desired(
               unique_code_id, unique_coupon_pool_id, unique_code_ord
             )
             WHERE NOT EXISTS (
               SELECT 1
                 FROM "unique_codes_pool_lnk" AS existing
                WHERE existing."unique_code_id" = desired.unique_code_id
                  AND existing."unique_coupon_pool_id" =
                      desired.unique_coupon_pool_id
             )
             ON CONFLICT DO NOTHING`,
            linkValues,
          );
        }

        return changedRows.length + mergedExistingCount;
      });

      processedTotal += codes.length;
      writtenTotal += written;
      duplicateTotal += collapsed.removed;
      lastSeenId = codes[codes.length - 1].id;
      logger.info(
        `  Batch ${batchNum}: processed ${codes.length}, wrote ${written}, ` +
          `collapsed ${collapsed.removed} duplicate(s) (${processedTotal}/${total})`
      );
    } catch (err: any) {
      logger.error(`Batch ${batchNum} failed: ${err.message}`);
      throw err;
    }
  }

  await pgTransaction(async () => {
    await pgQuery(
      `UPDATE "unique_coupon_pools"
          SET "total_codes" = 0,
              "used_codes" = 0`,
    );
    await pgQuery(
      `UPDATE "unique_coupon_pools" AS pool
          SET "total_codes" = inventory.total_codes,
              "used_codes" = inventory.used_codes
         FROM (
           SELECT
             link."unique_coupon_pool_id" AS pool_id,
             COUNT(*)::integer AS total_codes,
             COUNT(*) FILTER (WHERE code."is_used")::integer AS used_codes
           FROM "unique_codes_pool_lnk" AS link
           JOIN "unique_codes" AS code
             ON code.id = link."unique_code_id"
          GROUP BY link."unique_coupon_pool_id"
         ) AS inventory
        WHERE pool.id = inventory.pool_id`,
    );
  });

  logger.info(
    `Codes migration complete: ${processedTotal} processed, ` +
      `${writtenTotal} written, ${duplicateTotal} duplicate(s) collapsed`
  );
}
