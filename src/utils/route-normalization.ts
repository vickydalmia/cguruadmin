export type IdentityKind = 'store' | 'brand' | 'category' | 'bank';

const PLURAL_BY_KIND: Record<IdentityKind, string> = {
  store: 'stores',
  brand: 'brands',
  category: 'categories',
  bank: 'banks',
};

export function entityNamespaceAliases(kind: IdentityKind): [string, string] {
  return [kind, PLURAL_BY_KIND[kind]];
}

/**
 * Public route for a stored entity slug. This is the admin-side contract copy
 * of cguru-ui normalizeTypedSlug(): wrapping slashes are removed and an own
 * type namespace is stripped case-insensitively, while the surviving slug
 * keeps its original casing.
 */
export function toRouteSlug(value: unknown, kind: IdentityKind): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';

  const [namespace, ...rest] = trimmed.split('/');
  const aliases = entityNamespaceAliases(kind);
  if (
    rest.length > 0 &&
    aliases.includes(namespace.toLowerCase() as (typeof aliases)[number])
  ) {
    return rest.join('/');
  }
  return trimmed;
}

/**
 * Stored forms that can normalize to one flat route for a particular type.
 * Database callers use these as case-insensitive narrowing candidates and
 * must still confirm the normalized route exactly in JavaScript.
 */
export function routeSlugCandidates(
  route: string,
  kind: IdentityKind,
): string[] {
  const [singular, plural] = entityNamespaceAliases(kind);
  return [...new Set([route, `${singular}/${route}`, `${plural}/${route}`])];
}
