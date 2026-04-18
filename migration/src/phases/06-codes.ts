import { wpQuery } from "../db/wp-client.js";
import { getPgPool } from "../db/pg-client.js";
import { getPoolMapping } from "../utils/id-maps.js";
import { generateDocumentId } from "../utils/strapi-insert.js";
import { config } from "../config.js";
import { cleanCode } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";

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

  const [totalCount] = await wpQuery<{ c: number }>(
    "SELECT COUNT(*) AS c FROM wp_uc_codes"
  );
  const total = totalCount.c as number;
  logger.info(`Total unique codes to migrate: ${total}`);

  const batchSize = config.batchSize;
  let offset = 0;
  let insertedTotal = 0;
  let batchNum = 0;

  const pool = getPgPool();

  while (offset < total) {
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
      ORDER BY id
      LIMIT ${batchSize} OFFSET ${offset}
    `);

    if (codes.length === 0) break;

    // Build bulk INSERT values
    const values: any[] = [];
    const valuePlaceholders: string[] = [];
    const documentIds: string[] = [];
    let paramIdx = 1;

    for (const code of codes) {
      const documentId = generateDocumentId(`unique-code:${code.id}`);
      const isUsed = code.is_used === 1;
      documentIds.push(documentId);

      valuePlaceholders.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW(), NOW(), NOW(), $${paramIdx++})`
      );
      values.push(documentId, cleanCode(code.code) || code.code, isUsed, code.version || 0, null);
    }

    try {
      const sql = `
        INSERT INTO "unique_codes" ("document_id", "code", "is_used", "version", "created_at", "updated_at", "published_at", "locale")
        VALUES ${valuePlaceholders.join(", ")}
        ON CONFLICT ("document_id") DO NOTHING
        RETURNING id, document_id, code
      `;

      const result = await pool.query(sql, values);
      const insertedRows = result.rows as Array<{ id: number; document_id: string; code: string }>;
      const resolvedRows = await pool.query<{ id: number; document_id: string }>(
        `SELECT id, document_id
         FROM "unique_codes"
         WHERE document_id = ANY($1::text[])`,
        [documentIds]
      );
      const codeIdByDocumentId = new Map(
        resolvedRows.rows.map((row) => [row.document_id, row.id])
      );

      // Now link each code to its pool
      const linkValues: any[] = [];
      const linkPlaceholders: string[] = [];
      let linkIdx = 1;

      for (let i = 0; i < codes.length; i++) {
        const wpCode = codes[i];
        const uniqueCodeId = codeIdByDocumentId.get(documentIds[i]);
        if (!uniqueCodeId) continue;

        const poolRef = getPoolMapping(wpCode.coupon_id);
        if (poolRef) {
          linkPlaceholders.push(
            `($${linkIdx++}, $${linkIdx++}, $${linkIdx++})`
          );
          linkValues.push(uniqueCodeId, poolRef.id, 1);
        }
      }

      if (linkPlaceholders.length > 0) {
        // Insert links in sub-batches to stay within param limits
        const linkBatchSize = Math.floor(65535 / 3);
        for (let j = 0; j < linkPlaceholders.length; j += linkBatchSize) {
          const chunk = linkPlaceholders.slice(j, j + linkBatchSize);
          const chunkValues = linkValues.slice(j * 3, (j + linkBatchSize) * 3);

          // Renumber placeholders
          let idx = 1;
          const renumbered = chunk.map((p) =>
            p.replace(/\$\d+/g, () => `$${idx++}`)
          );

          const linkSql = `
            INSERT INTO "unique_codes_pool_lnk" ("unique_code_id", "unique_coupon_pool_id", "unique_code_ord")
            VALUES ${renumbered.join(", ")}
            ON CONFLICT DO NOTHING
          `;
          await pool.query(linkSql, chunkValues);
        }
      }

      insertedTotal += insertedRows.length;
      logger.info(
        `  Batch ${batchNum}: inserted ${insertedRows.length} codes (${insertedTotal}/${total})`
      );
    } catch (err: any) {
      logger.error(`Batch ${batchNum} failed: ${err.message}`);
    }

    offset += batchSize;
  }

  logger.info(`Codes migration complete: ${insertedTotal} inserted`);
}
