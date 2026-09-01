export type RelationUniqueIndex = {
  table: string;
  columns: readonly [string, string];
};

export const OFFER_RELATION_UNIQUE_INDEXES: readonly RelationUniqueIndex[] = [
  { table: "coupons_stores_lnk", columns: ["coupon_id", "store_id"] },
  { table: "coupons_brands_lnk", columns: ["coupon_id", "brand_id"] },
  { table: "coupons_categories_lnk", columns: ["coupon_id", "category_id"] },
  { table: "coupons_banks_lnk", columns: ["coupon_id", "bank_id"] },
  { table: "coupons_logo_store_lnk", columns: ["coupon_id", "store_id"] },
  {
    table: "coupons_unique_coupon_pool_lnk",
    columns: ["coupon_id", "unique_coupon_pool_id"],
  },
  { table: "deals_stores_lnk", columns: ["deal_id", "store_id"] },
  { table: "deals_brands_lnk", columns: ["deal_id", "brand_id"] },
  { table: "deals_categories_lnk", columns: ["deal_id", "category_id"] },
  { table: "deals_banks_lnk", columns: ["deal_id", "bank_id"] },
  { table: "deals_logo_store_lnk", columns: ["deal_id", "store_id"] },
] as const;

/** All names come from the fixed registry above, never editor/input data. */
export function relationUniqueIndexSql(spec: RelationUniqueIndex): string {
  return `CREATE UNIQUE INDEX IF NOT EXISTS "${spec.table}_uq" ` +
    `ON "${spec.table}" ("${spec.columns[0]}", "${spec.columns[1]}")`;
}
