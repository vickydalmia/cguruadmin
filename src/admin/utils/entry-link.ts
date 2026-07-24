/**
 * URL building for the content-manager list view's "open this entry" link.
 *
 * Everything here is deliberately basename-free: the returned paths are
 * router-absolute (`/content-manager/...`) and are handed to react-router's
 * `useHref`, which prefixes whatever basename the admin was built with
 * (`process.env.ADMIN_PATH`). Hardcoding '/admin' would break any deployment
 * served from a custom admin path.
 */

/**
 * Cell types the list view renders as plain text, so wrapping them in an anchor
 * is visually identical to Strapi's own `CellContent`. Relations, media and
 * components render their own interactive sub-trees (popovers, thumbnails,
 * nested links) and must never be nested inside a link.
 */
const LINKABLE_CELL_TYPES = new Set(['string', 'text', 'uid', 'email']);

export function isLinkableCellType(type: unknown): boolean {
  return typeof type === 'string' && LINKABLE_CELL_TYPES.has(type);
}

// Strapi documentIds are 24-char alphanumeric, but stay permissive while still
// refusing anything that could break out of the path segment (slash, ?, #, %).
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]+$/;

// Content-type uids look like `api::coupon.coupon` / `plugin::upload.file`.
// Strapi puts them in the URL unencoded, so match its own routes exactly rather
// than percent-encoding the `::`.
const SAFE_MODEL_UID = /^[A-Za-z0-9-]+::[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/;

const SAFE_COLLECTION_TYPE = /^[a-z-]+$/;

/**
 * Strapi's own row click forwards only the `plugins` query params to the edit
 * view (see `handleRowClick` in ListViewPage) — that is where i18n keeps the
 * active locale. Dropping it would land a Cmd-click on the default locale while
 * a plain click stays on the one being browsed, so mirror it exactly.
 * Bracket encoding matches `qs.stringify`, which is what Strapi uses.
 */
export function pickForwardedSearch(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const forwarded = new URLSearchParams();

  params.forEach((value, key) => {
    if (key === 'plugins' || key.startsWith('plugins[')) {
      forwarded.append(key, value);
    }
  });

  return forwarded.toString();
}

export function buildEntryEditPath(
  collectionType: unknown,
  model: unknown,
  documentId: unknown,
  search = ''
): string | null {
  if (
    typeof collectionType !== 'string' ||
    typeof model !== 'string' ||
    typeof documentId !== 'string' ||
    !SAFE_COLLECTION_TYPE.test(collectionType) ||
    !SAFE_MODEL_UID.test(model) ||
    !SAFE_DOCUMENT_ID.test(documentId)
  ) {
    return null;
  }

  const query = pickForwardedSearch(search);
  const path = `/content-manager/${collectionType}/${model}/${documentId}`;

  return query ? `${path}?${query}` : path;
}
