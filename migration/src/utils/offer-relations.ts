import { pgQuery } from "../db/pg-client.js";
import {
  ensureTermMapping,
  type StrapiEntityRef,
} from "./id-maps.js";
import {
  orderedUniqueTermIds,
  shouldLinkLogoStore,
} from "./offer-relation-order.js";

export { orderedUniqueTermIds } from "./offer-relation-order.js";

export type OfferTable = "coupons" | "deals";

type RelationTarget = {
  table: string;
  ownerColumn: "coupon_id" | "deal_id";
  targetColumn: "store_id" | "brand_id" | "category_id" | "bank_id";
  orderColumn: "coupon_ord" | "deal_ord";
};

type LogoStoreTarget = {
  table: "coupons_logo_store_lnk" | "deals_logo_store_lnk";
  ownerColumn: "coupon_id" | "deal_id";
};

const TARGETS: Record<
  OfferTable,
  Record<"stores" | "brands" | "categories" | "banks", RelationTarget>
> = {
  coupons: {
    stores: {
      table: "coupons_stores_lnk",
      ownerColumn: "coupon_id",
      targetColumn: "store_id",
      orderColumn: "coupon_ord",
    },
    brands: {
      table: "coupons_brands_lnk",
      ownerColumn: "coupon_id",
      targetColumn: "brand_id",
      orderColumn: "coupon_ord",
    },
    categories: {
      table: "coupons_categories_lnk",
      ownerColumn: "coupon_id",
      targetColumn: "category_id",
      orderColumn: "coupon_ord",
    },
    banks: {
      table: "coupons_banks_lnk",
      ownerColumn: "coupon_id",
      targetColumn: "bank_id",
      orderColumn: "coupon_ord",
    },
  },
  deals: {
    stores: {
      table: "deals_stores_lnk",
      ownerColumn: "deal_id",
      targetColumn: "store_id",
      orderColumn: "deal_ord",
    },
    brands: {
      table: "deals_brands_lnk",
      ownerColumn: "deal_id",
      targetColumn: "brand_id",
      orderColumn: "deal_ord",
    },
    categories: {
      table: "deals_categories_lnk",
      ownerColumn: "deal_id",
      targetColumn: "category_id",
      orderColumn: "deal_ord",
    },
    banks: {
      table: "deals_banks_lnk",
      ownerColumn: "deal_id",
      targetColumn: "bank_id",
      orderColumn: "deal_ord",
    },
  },
};

const LOGO_STORE_TARGETS: Record<OfferTable, LogoStoreTarget> = {
  coupons: {
    table: "coupons_logo_store_lnk",
    ownerColumn: "coupon_id",
  },
  deals: {
    table: "deals_logo_store_lnk",
    ownerColumn: "deal_id",
  },
};

type RelationTable = keyof typeof TARGETS["deals"];

export type ResolvedOfferTaxonomyRelations = {
  idsByTable: Record<RelationTable, number[]>;
  logoStoreId: number | null;
};

function groupedRelationIds(
  refs: readonly StrapiEntityRef[],
): Record<RelationTable, number[]> {
  const grouped: Record<RelationTable, number[]> = {
    stores: [],
    brands: [],
    categories: [],
    banks: [],
  };
  for (const ref of refs) {
    if (!["stores", "brands", "categories", "banks"].includes(ref.table)) {
      continue;
    }
    const table = ref.table as RelationTable;
    const ids = grouped[table];
    if (!ids.includes(ref.id)) ids.push(ref.id);
  }
  return grouped;
}

/**
 * Resolve persisted WordPress term ids before an offer transaction opens.
 * A missing id-map entry may query PostgreSQL, so this work must not hold a
 * transaction connection while waiting.
 */
export async function resolveOfferTaxonomyRelations(input: {
  termIds: readonly number[];
  logoStoreTermIds?: readonly number[];
  logoStoreOnlyWithoutStore?: boolean;
}): Promise<ResolvedOfferTaxonomyRelations> {
  const refs: StrapiEntityRef[] = [];
  for (const termId of orderedUniqueTermIds(input)) {
    const ref = await ensureTermMapping(termId);
    if (ref) refs.push(ref);
  }
  const idsByTable = groupedRelationIds(refs);
  let logoStoreId: number | null = null;
  if (
    shouldLinkLogoStore({
      onlyWithoutStore: input.logoStoreOnlyWithoutStore,
      storeIds: idsByTable.stores,
    })
  ) {
    for (const termId of input.logoStoreTermIds ?? []) {
      const ref = await ensureTermMapping(termId);
      if (ref?.table === "stores") {
        logoStoreId = ref.id;
        break;
      }
    }
  }

  return { idsByTable, logoStoreId };
}

export type ResolvedOfferTaxonomyRelationBatchEntry = {
  entityId: number;
  resolved: ResolvedOfferTaxonomyRelations;
};

/**
 * Reconcile all four taxonomy link tables and Logo Store for a whole offer
 * batch in one PostgreSQL statement. Each table deletes only rows absent from
 * the desired set, while desired rows are inserted/upserted with exact source
 * order. Delete and upsert sets are disjoint, so data-modifying CTE execution
 * order cannot create a delete/insert race.
 */
export function buildOfferTaxonomyRelationBatchQuery(
  offerTable: OfferTable,
  entries: readonly ResolvedOfferTaxonomyRelationBatchEntry[],
): { sql: string; params: unknown[] } {
  if (entries.length === 0) {
    throw new Error("Offer taxonomy relation batch cannot be empty");
  }
  const ctes: string[] = [];
  const summaries: string[] = [];
  const ownerIds = entries.map((entry) => entry.entityId);
  const params: unknown[] = [ownerIds];

  for (const [termTable, target] of Object.entries(TARGETS[offerTable]) as Array<
    [RelationTable, RelationTarget]
  >) {
    const desiredOwnerIds: number[] = [];
    const desiredTargetIds: number[] = [];
    const desiredOrders: number[] = [];
    for (const entry of entries) {
      entry.resolved.idsByTable[termTable].forEach((targetId, index) => {
        desiredOwnerIds.push(entry.entityId);
        desiredTargetIds.push(targetId);
        desiredOrders.push(index + 1);
      });
    }
    params.push(desiredOwnerIds, desiredTargetIds, desiredOrders);
    const ownerParam = `$${params.length - 2}`;
    const targetParam = `$${params.length - 1}`;
    const orderParam = `$${params.length}`;
    const alias = termTable.replace(/[^a-z0-9_]/giu, "_");
    const desired = `desired_${alias}`;
    const deleted = `deleted_${alias}`;
    const upserted = `upserted_${alias}`;

    ctes.push(
      `${desired}(owner_id, target_id, relation_order) AS (
         SELECT owner_id, target_id, relation_order
           FROM unnest(
             ${ownerParam}::integer[],
             ${targetParam}::integer[],
             ${orderParam}::integer[]
           ) AS relation(owner_id, target_id, relation_order)
       )`,
      `${deleted} AS (
         DELETE FROM "${target.table}" existing
          WHERE existing."${target.ownerColumn}" = ANY($1::integer[])
            AND NOT EXISTS (
              SELECT 1 FROM ${desired} desired
               WHERE desired.owner_id = existing."${target.ownerColumn}"
                 AND desired.target_id = existing."${target.targetColumn}"
            )
         RETURNING 1
       )`,
      `${upserted} AS (
         INSERT INTO "${target.table}" (
           "${target.ownerColumn}", "${target.targetColumn}", "${target.orderColumn}"
         )
         SELECT desired.owner_id, desired.target_id, desired.relation_order
           FROM ${desired} desired
         ON CONFLICT ("${target.ownerColumn}", "${target.targetColumn}")
         DO UPDATE SET "${target.orderColumn}" = EXCLUDED."${target.orderColumn}"
         RETURNING 1
       )`,
    );
    summaries.push(
      `(SELECT COUNT(*) FROM ${deleted}) + ` +
        `(SELECT COUNT(*) FROM ${upserted})`,
    );
  }

  const logoTarget = LOGO_STORE_TARGETS[offerTable];
  const logoOwnerIds: number[] = [];
  const logoStoreIds: number[] = [];
  for (const entry of entries) {
    if (entry.resolved.logoStoreId === null) continue;
    logoOwnerIds.push(entry.entityId);
    logoStoreIds.push(entry.resolved.logoStoreId);
  }
  params.push(logoOwnerIds, logoStoreIds);
  const logoOwnerParam = `$${params.length - 1}`;
  const logoStoreParam = `$${params.length}`;
  ctes.push(
    `desired_logo_store(owner_id, target_id) AS (
       SELECT owner_id, target_id
         FROM unnest(
           ${logoOwnerParam}::integer[],
           ${logoStoreParam}::integer[]
         ) AS relation(owner_id, target_id)
     )`,
    `deleted_logo_store AS (
       DELETE FROM "${logoTarget.table}" existing
        WHERE existing."${logoTarget.ownerColumn}" = ANY($1::integer[])
          AND NOT EXISTS (
            SELECT 1 FROM desired_logo_store desired
             WHERE desired.owner_id = existing."${logoTarget.ownerColumn}"
               AND desired.target_id = existing."store_id"
          )
       RETURNING 1
     )`,
    `upserted_logo_store AS (
       INSERT INTO "${logoTarget.table}" (
         "${logoTarget.ownerColumn}", "store_id"
       )
       SELECT desired.owner_id, desired.target_id
         FROM desired_logo_store desired
       ON CONFLICT ("${logoTarget.ownerColumn}", "store_id") DO NOTHING
       RETURNING 1
     )`,
  );
  summaries.push(
    `(SELECT COUNT(*) FROM deleted_logo_store) + ` +
      `(SELECT COUNT(*) FROM upserted_logo_store)`,
  );

  return {
    sql:
      `WITH ${ctes.join(",\n")}
       SELECT ${summaries.join(" + ")} AS affected_rows`,
    params,
  };
}

export function buildOfferTaxonomyRelationQuery(
  offerTable: OfferTable,
  entityId: number,
  resolved: ResolvedOfferTaxonomyRelations,
): { sql: string; params: unknown[] } {
  return buildOfferTaxonomyRelationBatchQuery(offerTable, [
    { entityId, resolved },
  ]);
}

export async function replaceResolvedOfferTaxonomyRelationBatch(
  offerTable: OfferTable,
  entries: readonly ResolvedOfferTaxonomyRelationBatchEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const query = buildOfferTaxonomyRelationBatchQuery(offerTable, entries);
  await pgQuery(query.sql, query.params);
}

export async function replaceResolvedOfferTaxonomyRelations(
  offerTable: OfferTable,
  entityId: number,
  resolved: ResolvedOfferTaxonomyRelations,
): Promise<void> {
  const query = buildOfferTaxonomyRelationQuery(
    offerTable,
    entityId,
    resolved,
  );
  await pgQuery(query.sql, query.params);
}

/**
 * Replace all WordPress-owned taxonomy links and the image-only Logo Store
 * for one offer. Logo Store is deliberately resolved separately: it supplies
 * artwork and must never create Store membership.
 * This is the re-import boundary: stale rows disappear and order converges
 * exactly to the current WP source. One SQL statement keeps it atomic.
 */
export async function replaceOfferTaxonomyRelations(
  offerTable: OfferTable,
  entityId: number,
  input: {
    termIds: readonly number[];
    logoStoreTermIds?: readonly number[];
    logoStoreOnlyWithoutStore?: boolean;
  },
): Promise<void> {
  const resolved = await resolveOfferTaxonomyRelations(input);
  await replaceResolvedOfferTaxonomyRelations(
    offerTable,
    entityId,
    resolved,
  );
}
