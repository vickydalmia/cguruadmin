export type HomepageHeroEntityType = 'deal' | 'coupon';

type HeroOfferLike = {
  entityType?: unknown;
  deal?: unknown;
  coupon?: unknown;
};

const hasRelationValue = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' || typeof value === 'number';
  }
  const relation = value as Record<string, unknown>;
  if (Array.isArray(relation.set)) return relation.set.length > 0;
  if (Array.isArray(relation.connect)) return relation.connect.length > 0;
  return relation.id != null || relation.documentId != null;
};

/**
 * Normalize the wire component's discriminator. Existing Deal-only rows have
 * no entityType yet, so relation inference keeps them readable until an
 * editor saves the Homepage and persists the new default.
 */
export function homepageHeroEntityType(
  item: HeroOfferLike | null | undefined,
): HomepageHeroEntityType | null {
  if (item?.entityType === 'deal' || item?.entityType === 'coupon') {
    return item.entityType;
  }
  if (hasRelationValue(item?.deal)) return 'deal';
  if (hasRelationValue(item?.coupon)) return 'coupon';
  return null;
}

export function homepageHeroOfferTarget(
  item: HeroOfferLike | null | undefined,
): unknown {
  const entityType = homepageHeroEntityType(item);
  return entityType === 'deal'
    ? item?.deal
    : entityType === 'coupon'
      ? item?.coupon
      : null;
}

/**
 * Conditional fields are omitted by Strapi's edit form when hidden. Clear the
 * opposite relation explicitly so switching a row never leaves both a Coupon
 * and Product Deal attached in the database.
 */
export function normaliseHomepageHeroOfferFields<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const hero = Reflect.get(data, 'hero');
  if (!hero || typeof hero !== 'object') return data;
  const products = Reflect.get(hero, 'products');
  if (!Array.isArray(products)) return data;

  for (const item of products) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!Object.prototype.hasOwnProperty.call(item, 'entityType')) continue;
    if (Reflect.get(item, 'entityType') === 'coupon') {
      Reflect.set(item, 'deal', null);
      Reflect.set(item, 'imageOverride', null);
    } else if (Reflect.get(item, 'entityType') === 'deal') {
      Reflect.set(item, 'coupon', null);
    }
  }
  return data;
}
