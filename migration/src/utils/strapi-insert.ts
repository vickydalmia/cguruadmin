import { createId } from "@paralleldrive/cuid2";
import { createHash } from "crypto";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import { logger } from "./logger.js";

export function generateDocumentId(sourceKey?: string): string {
  if (sourceKey) {
    return createHash("sha256").update(sourceKey).digest("hex").slice(0, 24);
  }
  return createId();
}

export async function getEntityIdByDocumentId(
  table: string,
  documentId: string
): Promise<number | null> {
  const rows = await pgQuery<{ id: number }>(
    `SELECT id FROM "${table}" WHERE "document_id" = $1 LIMIT 1`,
    [documentId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Batch INSERT rows into a PG table. Returns the inserted rows with their IDs.
 * Uses ON CONFLICT DO NOTHING for idempotency when conflictColumn is provided.
 */
export async function batchInsert<T extends Record<string, any>>(
  table: string,
  rows: T[],
  conflictColumn?: string
): Promise<Array<T & { id: number }>> {
  if (rows.length === 0) return [];

  const columns = Object.keys(rows[0]);
  const results: Array<T & { id: number }> = [];

  // Insert in chunks to avoid parameter limit (65535 params max in PG)
  const chunkSize = Math.floor(65535 / columns.length);

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: any[] = [];
    const valuePlaceholders: string[] = [];

    chunk.forEach((row, rowIdx) => {
      const rowPlaceholders: string[] = [];
      columns.forEach((col, colIdx) => {
        const paramIdx = rowIdx * columns.length + colIdx + 1;
        rowPlaceholders.push(`$${paramIdx}`);
        values.push(row[col] ?? null);
      });
      valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
    });

    const conflictClause = conflictColumn
      ? `ON CONFLICT ("${conflictColumn}") DO NOTHING`
      : "";

    const sql = `
      INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
      VALUES ${valuePlaceholders.join(", ")}
      ${conflictClause}
      RETURNING *
    `;

    try {
      const inserted = await pgQuery<T & { id: number }>(sql, values);
      results.push(...inserted);
    } catch (err: any) {
      logger.error(
        `Batch insert into ${table} failed (chunk ${i / chunkSize}): ${err.message}`
      );
      throw err;
    }
  }

  return results;
}

/**
 * Insert a single row and return it with its ID.
 */
export async function insertOne<T extends Record<string, any>>(
  table: string,
  row: T
): Promise<T & { id: number }> {
  const results = await batchInsert(table, [row]);
  return results[0];
}

/**
 * Insert a component row and link it to an entity via the component join table.
 */
export async function insertComponent(
  componentTable: string,
  componentData: Record<string, any>,
  entityTable: string,
  entityId: number,
  field: string,
  componentType: string,
  order: number = 1
): Promise<number> {
  const cmpTable = `${entityTable}_cmps`;

  const existingLink = await pgQuery<{ cmp_id: number }>(
    `
      SELECT "cmp_id"
      FROM "${cmpTable}"
      WHERE "entity_id" = $1
        AND "field" = $2
        AND "component_type" = $3
        AND "order" = $4
      LIMIT 1
    `,
    [entityId, field, componentType, order]
  );
  if (existingLink[0]?.cmp_id) {
    return existingLink[0].cmp_id;
  }

  // Insert component row
  const columns = Object.keys(componentData);
  const values = columns.map((c) => componentData[c] ?? null);
  const placeholders = columns.map((_, i) => `$${i + 1}`);

  const insertSql = `
    INSERT INTO "${componentTable}" (${columns.map((c) => `"${c}"`).join(", ")})
    VALUES (${placeholders.join(", ")})
    RETURNING id
  `;
  const compResult = await pgQuery<{ id: number }>(insertSql, values);
  const componentId = compResult[0].id;

  // Link via entity's component join table
  const linkSql = `
    INSERT INTO "${cmpTable}" ("entity_id", "cmp_id", "component_type", "field", "order")
    VALUES ($1, $2, $3, $4, $5)
  `;
  await pgQuery(linkSql, [entityId, componentId, componentType, field, order]);

  return componentId;
}

/**
 * Replace one repeatable/single component field with the exact imported rows.
 * Existing component ids are updated in place; excess rows are unlinked and
 * deleted so shortening an FAQ or clearing SEO converges on re-import.
 */
export async function replaceComponents(
  componentTable: string,
  rows: Array<Record<string, any>>,
  entityTable: string,
  entityId: number,
  field: string,
  componentType: string
): Promise<void> {
  const cmpTable = `${entityTable}_cmps`;

  await pgTransaction(async () => {
    const existing = await pgQuery<{ cmp_id: number; order: number }>(
      `SELECT "cmp_id", "order"
         FROM "${cmpTable}"
        WHERE "entity_id" = $1
          AND "field" = $2
          AND "component_type" = $3
        ORDER BY "order", "cmp_id"`,
      [entityId, field, componentType]
    );
    const byOrder = new Map(existing.map((link) => [link.order, link.cmp_id]));

    for (let index = 0; index < rows.length; index++) {
      const order = index + 1;
      const currentId = byOrder.get(order);
      if (!currentId) {
        await insertComponent(
          componentTable,
          rows[index],
          entityTable,
          entityId,
          field,
          componentType,
          order
        );
        continue;
      }

      const columns = Object.keys(rows[index]);
      if (columns.length === 0) continue;
      await pgQuery(
        `UPDATE "${componentTable}"
            SET ${columns.map((column, i) => `"${column}" = $${i + 1}`).join(", ")}
          WHERE "id" = $${columns.length + 1}`,
        [...columns.map((column) => rows[index][column] ?? null), currentId]
      );
    }

    const staleIds = existing
      .filter((link) => link.order > rows.length)
      .map((link) => link.cmp_id);
    if (staleIds.length > 0) {
      await pgQuery(
        `DELETE FROM "${cmpTable}"
          WHERE "entity_id" = $1
            AND "field" = $2
            AND "component_type" = $3
            AND "cmp_id" = ANY($4::int[])`,
        [entityId, field, componentType, staleIds]
      );
      await pgQuery(
        `DELETE FROM "${componentTable}" WHERE "id" = ANY($1::int[])`,
        [staleIds]
      );
    }
  });
}

/**
 * Insert a relation link row.
 */
export async function insertLink(
  linkTable: string,
  columns: Record<string, number>
): Promise<void> {
  const cols = Object.keys(columns);
  const vals = cols.map((c) => columns[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  const sql = `
    INSERT INTO "${linkTable}" (${cols.map((c) => `"${c}"`).join(", ")})
    VALUES (${placeholders.join(", ")})
    ON CONFLICT DO NOTHING
  `;
  await pgQuery(sql, vals);
}

/**
 * Insert a files_related_morphs row to link media.
 */
export async function linkMedia(
  fileId: number,
  relatedId: number,
  relatedType: string,
  field: string,
  order: number = 1
): Promise<void> {
  const sql = `
    INSERT INTO "files_related_mph" ("file_id", "related_id", "related_type", "field", "order")
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING
  `;
  await pgQuery(sql, [fileId, relatedId, relatedType, field, order]);
}

/**
 * Replace one media field exactly. Unlike linkMedia this removes a previous
 * WordPress image when the source changes or is cleared on an in-place import.
 */
export async function replaceMedia(
  fileId: number | null,
  relatedId: number,
  relatedType: string,
  field: string
): Promise<void> {
  await pgTransaction(async () => {
    await pgQuery(
      `DELETE FROM "files_related_mph"
       WHERE "related_id" = $1 AND "related_type" = $2 AND "field" = $3`,
      [relatedId, relatedType, field]
    );
    if (fileId) {
      await linkMedia(fileId, relatedId, relatedType, field, 1);
    }
  });
}

/**
 * Register images referenced inside rewritten rich-text HTML as "used" media.
 * Phase 11 copies only files present in files_related_mph, so every
 * rewriteContentMedia call site must link its fileIds through here or the
 * files silently never reach public/uploads on the local provider.
 */
export async function linkContentMedia(
  fileIds: number[],
  relatedId: number,
  relatedType: string,
  field: string
): Promise<void> {
  for (let i = 0; i < fileIds.length; i++) {
    await linkMedia(fileIds[i], relatedId, relatedType, field, i + 1);
  }
}

export async function replaceContentMedia(
  fileIds: number[],
  relatedId: number,
  relatedType: string,
  field: string
): Promise<void> {
  await pgTransaction(async () => {
    await pgQuery(
      `DELETE FROM "files_related_mph"
       WHERE "related_id" = $1 AND "related_type" = $2 AND "field" = $3`,
      [relatedId, relatedType, field]
    );
    await linkContentMedia(fileIds, relatedId, relatedType, field);
  });
}
