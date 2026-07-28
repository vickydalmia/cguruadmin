/**
 * The single definition of an acceptable editor-supplied canonical path.
 *
 * There used to be two copies of this rule — one in
 * entity-deal-page-seo-validation.ts, one in the entity-deal-page service — and
 * they had already drifted. Both blocked `<` and `>` while allowing `"` and
 * `'`, even though their shared error message promised to reject "markup": a
 * value like `/x" onload="…/` passed validation and was emitted as
 * `seo.canonical`, which is an attribute-injection payload the moment any
 * renderer interpolates it without escaping.
 *
 * The rule is now a positive ALLOW-LIST — the unreserved URL path characters
 * from RFC 3986 plus `/` — so a new dangerous character is excluded by default
 * instead of needing to be remembered. Query strings and fragments stay out:
 * a canonical must name exactly one page.
 */
const CANONICAL_PATH = /^\/[A-Za-z0-9\-._~/]*$/;

export const CANONICAL_PATH_RULE =
  'must be a root-relative path using only letters, digits and - . _ ~ / '
  + '(no query, fragment, backslash, quotes, or markup)';

export function isValidCanonicalPath(value: string): boolean {
  return (
    CANONICAL_PATH.test(value)
    // `//host/path` is protocol-relative: it leaves the site entirely.
    && !value.startsWith('//')
  );
}

/**
 * Normalize an editor-supplied canonical to a trailing-slash path, or null if
 * it is absent or fails the rule above.
 */
export function normalizeCanonicalPath(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !isValidCanonicalPath(raw)) return null;
  return raw.endsWith('/') ? raw : `${raw}/`;
}
