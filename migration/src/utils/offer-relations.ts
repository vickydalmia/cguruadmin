import { pgQuery, pgTransaction } from "../db/pg-client.js";
import {
  ensureTermMapping,
  type StrapiEntityRef,
} from "./id-maps.js";
import { orderedUniqueTermIds } from "./offer-relation-order.js";

export { orderedUniqueTermIds } from "./offer-relation-order.js";

export type OfferTable = "coupons" | "deals";

type RelationTarget = {
  table: string;
  ownerColumn: "coupon_id" | "deal_id";
  targetColumn: "store_id" | "brand_id" | "category_id" | "bank_id";
  orderColumn: "coupon_ord" | "deal_ord";
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

function groupedRelationIds(
  refs: readonly StrapiEntityRef[],
): Map<keyof typeof TARGETS["deals"], number[]> {
  const grouped = new Map<keyof typeof TARGETS["deals"], number[]>();
  for (const ref of refs) {
    if (!["stores", "brands", "categories", "banks"].includes(ref.table)) {
      continue;
    }
    const table = ref.table as keyof typeof TARGETS["deals"];
    const ids = grouped.get(table) ?? [];
    if (!ids.includes(ref.id)) ids.push(ref.id);
    grouped.set(table, ids);
  }
  return grouped;
}

/**
 * Replace all WordPress-owned taxonomy links for one offer. This is the
 * re-import boundary: stale rows disappear and order converges exactly to the
 * current WP source. The delete+insert set is atomic for each offer.
 */
export async function replaceOfferTaxonomyRelations(
  offerTable: OfferTable,
  entityId: number,
  input: {
    termIds: readonly number[];
    primaryTermId?: number;
    acfStoreTermId?: number | null;
  },
): Promise<void> {
  const refs: StrapiEntityRef[] = [];
  for (const termId of orderedUniqueTermIds(input)) {
    const ref = await ensureTermMapping(termId);
    if (ref) refs.push(ref);
  }
  const grouped = groupedRelationIds(refs);

  await pgTransaction(async () => {
    for (const [termTable, target] of Object.entries(TARGETS[offerTable])) {
      await pgQuery(
        `DELETE FROM "${target.table}" WHERE "${target.ownerColumn}" = $1`,
        [entityId],
      );

      const ids =
        grouped.get(termTable as keyof typeof TARGETS["deals"]) ?? [];
      for (let index = 0; index < ids.length; index++) {
        await pgQuery(
          `INSERT INTO "${target.table}" (
             "${target.ownerColumn}", "${target.targetColumn}", "${target.orderColumn}"
           ) VALUES ($1, $2, $3)`,
          [entityId, ids[index], index + 1],
        );
      }
    }
  });
}
