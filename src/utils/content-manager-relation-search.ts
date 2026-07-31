/**
 * Content Manager relation-picker search configuration.
 *
 * This is deliberately separate from CURATED_OFFER_RELATIONS. That list also
 * controls public live-offer filtering, cleanup, and ISR scope; this one only
 * tells Strapi Admin which visible text field to search for each relation.
 */
export type AdminRelationSearchField = Readonly<{
  sourceUid: string;
  field: string;
  targetUid: string;
  mainField: 'name' | 'title';
}>;

export const ADMIN_RELATION_SEARCH_FIELDS = [
  // Homepage offer relations.
  {
    sourceUid: 'home.hero-product',
    field: 'deal',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },
  {
    sourceUid: 'home.top-offer-item',
    field: 'coupon',
    targetUid: 'api::coupon.coupon',
    mainField: 'title',
  },
  {
    sourceUid: 'home.exclusive-item',
    field: 'coupon',
    targetUid: 'api::coupon.coupon',
    mainField: 'title',
  },
  {
    sourceUid: 'home.coupon-card-item',
    field: 'coupon',
    targetUid: 'api::coupon.coupon',
    mainField: 'title',
  },
  {
    sourceUid: 'home.offer-list',
    field: 'offers',
    targetUid: 'api::coupon.coupon',
    mainField: 'title',
  },
  {
    sourceUid: 'home.explore-offer-tab',
    field: 'offers',
    targetUid: 'api::coupon.coupon',
    mainField: 'title',
  },
  {
    sourceUid: 'home.deal-list',
    field: 'deals',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },
  {
    sourceUid: 'home.explore-tab',
    field: 'deals',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },

  // Homepage Store/Brand/Category/Bank relations.
  {
    sourceUid: 'home.bank-offer-item',
    field: 'bank',
    targetUid: 'api::bank.bank',
    mainField: 'name',
  },
  {
    sourceUid: 'home.explore-offer-tab',
    field: 'category',
    targetUid: 'api::category.category',
    mainField: 'name',
  },
  {
    sourceUid: 'home.explore-tab',
    field: 'category',
    targetUid: 'api::category.category',
    mainField: 'name',
  },
  {
    sourceUid: 'home.popular-stores',
    field: 'featuredStore',
    targetUid: 'api::store.store',
    mainField: 'name',
  },
  {
    sourceUid: 'home.popular-stores',
    field: 'stores',
    targetUid: 'api::store.store',
    mainField: 'name',
  },
  {
    sourceUid: 'home.popular-searches',
    field: 'stores',
    targetUid: 'api::store.store',
    mainField: 'name',
  },
  {
    sourceUid: 'home.popular-searches',
    field: 'brands',
    targetUid: 'api::brand.brand',
    mainField: 'name',
  },
  {
    sourceUid: 'home.popular-searches',
    field: 'categories',
    targetUid: 'api::category.category',
    mainField: 'name',
  },
  {
    sourceUid: 'home.popular-searches',
    field: 'banks',
    targetUid: 'api::bank.bank',
    mainField: 'name',
  },

  // Deal-of-the-Day relations.
  {
    sourceUid: 'deal-day.section-heading',
    field: 'deals',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },
  {
    sourceUid: 'deal-day.store-tab',
    field: 'store',
    targetUid: 'api::store.store',
    mainField: 'name',
  },
  {
    sourceUid: 'deal-day.store-tab',
    field: 'deals',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },
  {
    sourceUid: 'deal-day.telegram-deals',
    field: 'deals',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },

  // Preserve the existing header-notification admin search behaviour.
  {
    sourceUid: 'header.coupon-notification',
    field: 'coupon',
    targetUid: 'api::coupon.coupon',
    mainField: 'title',
  },
  {
    sourceUid: 'header.product-deal-notification',
    field: 'productDeal',
    targetUid: 'api::deal.deal',
    mainField: 'title',
  },
] as const satisfies readonly AdminRelationSearchField[];

export function groupAdminRelationSearchFields(
  fields: readonly AdminRelationSearchField[] = ADMIN_RELATION_SEARCH_FIELDS,
): Map<string, AdminRelationSearchField[]> {
  const grouped = new Map<string, AdminRelationSearchField[]>();
  for (const field of fields) {
    const componentFields = grouped.get(field.sourceUid) ?? [];
    componentFields.push(field);
    grouped.set(field.sourceUid, componentFields);
  }
  return grouped;
}

/**
 * Apply the desired main fields while retaining every unrelated metadata
 * property. A null result means the configuration is already correct.
 */
export function applyAdminRelationSearchFields(
  metadatas: Record<string, any> | null | undefined,
  fields: readonly Pick<AdminRelationSearchField, 'field' | 'mainField'>[],
): { metadatas: Record<string, any>; changedFields: string[] } | null {
  const next = { ...(metadatas ?? {}) };
  const changedFields: string[] = [];

  for (const { field, mainField } of fields) {
    const previous = next[field] ?? {};
    if (previous.edit?.mainField === mainField) continue;
    next[field] = {
      ...previous,
      edit: { ...(previous.edit ?? {}), mainField },
    };
    changedFields.push(field);
  }

  return changedFields.length > 0
    ? { metadatas: next, changedFields }
    : null;
}
