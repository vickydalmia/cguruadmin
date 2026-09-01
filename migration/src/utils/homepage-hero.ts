export type HomepageHeroSeedOffer = {
  entityType: "deal" | "coupon";
  id: number;
};

export type HomepageCouponOwnerLink = {
  table: string;
  sourceCol: string;
  targetCol: string;
  entityTable: "stores" | "brands";
  entityType: "api::store.store" | "api::brand.brand";
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Restrict the migration's Coupon hero fallback to records the public card can
 * actually render: a named, routable Store/Brand owner with a real logo URL.
 * The relation identifiers come from information_schema via detectLnk().
 */
export function homepageCouponOwnerEligibilitySql(
  links: readonly HomepageCouponOwnerLink[],
): string {
  if (links.length === 0) return "FALSE";

  const ownerClauses = links.map((link) => {
    const relationTable = quoteIdentifier(link.table);
    const sourceCol = quoteIdentifier(link.sourceCol);
    const targetCol = quoteIdentifier(link.targetCol);
    const entityTable = quoteIdentifier(link.entityTable);
    return {
      entityTable: link.entityTable,
      sql: `EXISTS (
         SELECT 1
         FROM ${relationTable} owner_link
         JOIN ${entityTable} owner
           ON owner.id = owner_link.${targetCol}
         JOIN "files_related_mph" owner_media
           ON owner_media.related_id = owner.id
          AND owner_media.related_type = '${link.entityType}'
          AND owner_media.field = 'logo'
         JOIN "files" owner_file
           ON owner_file.id = owner_media.file_id
         WHERE owner_link.${sourceCol} = c.id
           AND owner.published_at IS NOT NULL
           AND NULLIF(BTRIM(owner.name), '') IS NOT NULL
           AND NULLIF(BTRIM(owner.slug), '') IS NOT NULL
           AND NULLIF(BTRIM(owner_file.url), '') IS NOT NULL
       )`,
    };
  });
  const allOwners = ownerClauses.map(({ sql }) => sql).join("\n         OR ");
  const brandOwners =
    ownerClauses
      .filter(({ entityTable }) => entityTable === "brands")
      .map(({ sql }) => sql)
      .join("\n         OR ") || "FALSE";

  // Affiliate-brand Coupons intentionally ignore Store/logoStore artwork on
  // every public surface, so their eligibility must be Brand-only as well.
  return `(c.is_for_affiliate_brand IS TRUE AND (
         ${brandOwners}
       ))
       OR (c.is_for_affiliate_brand IS NOT TRUE AND (
         ${allOwners}
       ))`;
}

/** Prefer Product Deals exactly as the existing homepage seed did. Coupon is
 *  the schema-preserving fallback only when there are no published Deals. */
export function selectHomepageHeroOffers(
  dealIds: readonly number[],
  couponIds: readonly number[],
): HomepageHeroSeedOffer[] {
  const selected = dealIds.length > 0
    ? { entityType: "deal" as const, ids: dealIds }
    : { entityType: "coupon" as const, ids: couponIds };
  return selected.ids.map((id) => ({ entityType: selected.entityType, id }));
}
