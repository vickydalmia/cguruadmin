import { slugify } from '../../../constants/slugify';

export const ENTITY_DEAL_PAGE_SUFFIX = '-deals';

/**
 * Generated Product Deal routes are owned by the entity name, not by the
 * independently editable entity-page slug.
 */
export function entityDealPageSlug(entityName: unknown): string | null {
  if (typeof entityName !== 'string') return null;
  const nameSlug = slugify(entityName);
  return nameSlug ? `${nameSlug}${ENTITY_DEAL_PAGE_SUFFIX}` : null;
}

export function entityDealPagePath(entityName: unknown): string | null {
  const dealSlug = entityDealPageSlug(entityName);
  return dealSlug ? `/${dealSlug}/` : null;
}

export function parseEntityDealPageSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().replace(/^\/+|\/+$/g, '');
  if (
    !slug.endsWith(ENTITY_DEAL_PAGE_SUFFIX)
    || slug.length === ENTITY_DEAL_PAGE_SUFFIX.length
    || slug.includes('/')
  ) {
    return null;
  }
  return slug.slice(0, -ENTITY_DEAL_PAGE_SUFFIX.length) || null;
}
