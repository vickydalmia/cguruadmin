export type ParameterizedQuery = {
  sql: string;
  params: unknown[];
};

export const COUPON_INSERT_COLUMNS = [
  "document_id",
  "title",
  "offer_text",
  "cashback_text",
  "bank_offer_text",
  "prepaid_text",
  "offer_countries",
  "content",
  "code",
  "coupon_type",
  "badge",
  "affiliate_link",
  "expires_at",
  "scheduled_at",
  "content_status",
  "is_for_affiliate_brand",
  "published_at",
  "published_on",
  "created_at",
  "updated_at",
  "locale",
  "created_by_id",
  "updated_by_id",
] as const;

export function buildCouponUpsertBatchQuery(
  rows: readonly (readonly unknown[])[],
): ParameterizedQuery {
  if (rows.length === 0) throw new Error("Coupon upsert batch cannot be empty");
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    if (row.length !== COUPON_INSERT_COLUMNS.length) {
      throw new Error(
        `Coupon batch row has ${row.length} values; ` +
          `expected ${COUPON_INSERT_COLUMNS.length}`,
      );
    }
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  return {
    sql: `INSERT INTO "coupons" (
            ${COUPON_INSERT_COLUMNS.map((column) => `"${column}"`).join(", ")}
          ) VALUES ${tuples.join(",\n")}
          ON CONFLICT ("document_id") DO UPDATE SET
            "title" = EXCLUDED."title",
            "offer_text" = EXCLUDED."offer_text",
            "cashback_text" = EXCLUDED."cashback_text",
            "bank_offer_text" = EXCLUDED."bank_offer_text",
            "prepaid_text" = EXCLUDED."prepaid_text",
            "offer_countries" = EXCLUDED."offer_countries",
            "content" = EXCLUDED."content",
            "code" = EXCLUDED."code",
            "coupon_type" = EXCLUDED."coupon_type",
            "badge" = COALESCE(EXCLUDED."badge", "coupons"."badge"),
            "affiliate_link" = EXCLUDED."affiliate_link",
            "expires_at" = EXCLUDED."expires_at",
            "scheduled_at" = EXCLUDED."scheduled_at",
            "content_status" = EXCLUDED."content_status",
            "is_for_affiliate_brand" = EXCLUDED."is_for_affiliate_brand",
            "published_at" = EXCLUDED."published_at",
            "published_on" = EXCLUDED."published_on",
            "updated_at" = EXCLUDED."updated_at",
            "updated_by_id" = EXCLUDED."updated_by_id"
          RETURNING id, document_id`,
    params,
  };
}

export function buildCouponRegistryBatchQuery(
  rows: readonly {
    documentId: string;
    sourceKey: string;
  }[],
): ParameterizedQuery {
  if (rows.length === 0) throw new Error("Coupon registry batch cannot be empty");
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    params.push(row.documentId, row.sourceKey, "coupons");
    const start = params.length - 2;
    return `($${start}, $${start + 1}, $${start + 2})`;
  });
  return {
    sql: `INSERT INTO "migration_source_entities" (
            "document_id", "source_key", "target_table"
          ) VALUES ${tuples.join(", ")}
          ON CONFLICT ("target_table", "source_key") DO UPDATE SET
            "document_id" = EXCLUDED."document_id",
            "updated_at" = NOW()`,
    params,
  };
}

export function buildCouponContentMediaBatchQueries(
  entries: readonly {
    entityId: number;
    fileIds: readonly number[];
    reconcile: boolean;
  }[],
): ParameterizedQuery[] {
  const scoped = entries.filter((entry) => entry.reconcile);
  if (scoped.length === 0) return [];
  const queries: ParameterizedQuery[] = [{
    sql: `DELETE FROM "files_related_mph"
           WHERE "related_type" = 'api::coupon.coupon'
             AND "field" = 'content'
             AND "related_id" = ANY($1::integer[])`,
    params: [scoped.map((entry) => entry.entityId)],
  }];

  const fileIds: number[] = [];
  const entityIds: number[] = [];
  const orders: number[] = [];
  for (const entry of scoped) {
    [...new Set(entry.fileIds)].forEach((fileId, index) => {
      fileIds.push(fileId);
      entityIds.push(entry.entityId);
      orders.push(index + 1);
    });
  }
  if (fileIds.length > 0) {
    queries.push({
      sql: `INSERT INTO "files_related_mph" (
              "file_id", "related_id", "related_type", "field", "order"
            )
            SELECT file_id, related_id, 'api::coupon.coupon', 'content', relation_order
              FROM unnest(
                $1::integer[], $2::integer[], $3::integer[]
              ) AS relation(file_id, related_id, relation_order)
            ON CONFLICT DO NOTHING`,
      params: [fileIds, entityIds, orders],
    });
  }
  return queries;
}

export function buildCouponPoolBatchQueries(
  entries: readonly {
    entityId: number;
    poolId: number | null;
    reconcile: boolean;
  }[],
): ParameterizedQuery[] {
  const scoped = entries.filter((entry) => entry.reconcile);
  if (scoped.length === 0) return [];
  const queries: ParameterizedQuery[] = [{
    sql: `DELETE FROM "coupons_unique_coupon_pool_lnk"
           WHERE "coupon_id" = ANY($1::integer[])`,
    params: [scoped.map((entry) => entry.entityId)],
  }];
  const desired = scoped.filter(
    (entry): entry is typeof entry & { poolId: number } => entry.poolId !== null,
  );
  if (desired.length > 0) {
    queries.push({
      sql: `INSERT INTO "coupons_unique_coupon_pool_lnk" (
              "coupon_id", "unique_coupon_pool_id", "coupon_ord"
            )
            SELECT coupon_id, pool_id, 1
              FROM unnest($1::integer[], $2::integer[])
                AS relation(coupon_id, pool_id)
            ON CONFLICT ("coupon_id", "unique_coupon_pool_id") DO UPDATE SET
              "coupon_ord" = EXCLUDED."coupon_ord"`,
      params: [
        desired.map((entry) => entry.entityId),
        desired.map((entry) => entry.poolId),
      ],
    });
  }
  return queries;
}
