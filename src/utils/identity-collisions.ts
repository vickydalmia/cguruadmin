// The identity collision queries: duplicate names, slug/route collisions
// across the four taxonomy types, entity-deal-page route collisions, and
// active-redirect shadowing. Split out of identity-validation.ts, which
// keeps the write orchestration. Every query here is a NARROWING pass
// re-confirmed in JS — see each function's doc.
import type { Core } from '@strapi/strapi';
import {
  routeSlugCandidates,
  toRouteSlug,
  type IdentityKind,
} from './route-normalization';
import { entityDealPageSlug } from '../api/entity-deal-page/services/entity-deal-route';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { IDENTITY_UIDS, KIND_BY_UID, type IdentityUid } from './identity-uids';
import { readString } from './row-fields';

// `$containsi` compiles to `LIKE '%value%'`, which cannot use an index — but
// these tables hold hundreds of rows, and the query only runs when the name
// actually changed. Candidates are read in pages (below) rather than truncated
// at a single limit: a single limit silently DROPPED any true duplicate past
// the cap, letting a supposedly-unique name save (#8). NAME_SCAN_PAGE is the
// page size; NAME_SCAN_MAX_PAGES only backstops a pathological one-character
// name against an unbounded scan, and hitting it is logged, never silent.
const NAME_SCAN_PAGE = 500;
const NAME_SCAN_MAX_PAGES = 40;
const SLUG_CANDIDATE_LIMIT = 25;

/**
 * The key names are compared on: case-insensitive and trim-insensitive, so
 * "Amazon", "amazon" and " AMAZON " are one name.
 */
export function toNameKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Another row of the SAME type carrying the same name, ignoring case and
 * surrounding whitespace. Returns its name, or null.
 *
 * The filter is a NARROWING PASS ONLY. `$containsi` is a LIKE, so a name
 * containing '%' or '_' wildcards — "50% Off Store" must still save — matches
 * rows that are not equal to it. LIKE with those wildcards always returns a
 * SUPERSET of the true matches (never fewer), which is exactly what a
 * candidate query needs: every hit is then confirmed in JS with an exact
 * key comparison, and the wildcard extras are discarded.
 */
export async function findDuplicateName(
  strapi: Core.Strapi,
  uid: IdentityUid,
  name: string,
  documentId: string | undefined,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<string | null> {
  const key = toNameKey(name);
  if (!key) return null;

  // `$containsi` rather than `$eqi`: it is the narrowest sound superset that
  // also catches stored names with leading/trailing whitespace, which an exact
  // `$eqi` on the trimmed value would miss. Read EVERY candidate page rather
  // than a single capped slice — a cap would silently let a real duplicate past
  // it save (#8). The exact key comparison then confirms each candidate in JS.
  for (let page = 0; page < NAME_SCAN_MAX_PAGES; page += 1) {
    const rows: unknown = await strapi.documents(uid).findMany({
      locale,
      filters: { name: { $containsi: name.trim() } },
      fields: ['documentId', 'name'],
      limit: NAME_SCAN_PAGE,
      start: page * NAME_SCAN_PAGE,
    });

    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      if (documentId && readString(row, 'documentId') === documentId) continue;
      const candidate = readString(row, 'name');
      if (candidate !== undefined && toNameKey(candidate) === key) return candidate;
    }

    // A short page is the last page — the whole candidate set has been scanned.
    if (list.length < NAME_SCAN_PAGE) return null;
  }

  // Only a pathological broad match (e.g. a one-character name matching most of
  // an unexpectedly huge table) reaches here. Do not fail silently: log so the
  // uniqueness check is known to be incomplete for this one save.
  strapi.log.warn(
    `[identity] name uniqueness scan for ${uid} hit ${NAME_SCAN_MAX_PAGES} pages ` +
      `(${NAME_SCAN_MAX_PAGES * NAME_SCAN_PAGE} rows) without exhausting candidates — ` +
      `duplicate detection may be incomplete for "${name.trim()}".`,
  );
  return null;
}

/**
 * A row of ANY of the four types already routing at the same public slug.
 *
 * The filter is exact (`$in` over the canonical stored forms), so no LIKE
 * wildcard can leak in here; the JS pass re-derives each candidate's route
 * slug anyway so the decision never rests on the filter alone.
 */
export async function findSlugCollision(
  strapi: Core.Strapi,
  uid: IdentityUid,
  route: string,
  documentId: string | undefined,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<{ kind: IdentityKind; name: string; slug: string } | null> {
  for (const targetUid of IDENTITY_UIDS) {
    const targetKind = KIND_BY_UID[targetUid];
    // A stored slug routes to `route` only if it is `route` itself or `route`
    // behind its own type namespace — the three forms normalizeTypedSlug()
    // collapses.
    const candidates = routeSlugCandidates(route, targetKind);

    const rows: unknown = await strapi.documents(targetUid).findMany({
      locale,
      filters: {
        $or: candidates.map((candidate) => ({ slug: { $eqi: candidate } })),
      } as any,
      fields: ['documentId', 'name', 'slug'],
      limit: SLUG_CANDIDATE_LIMIT,
    });

    for (const row of Array.isArray(rows) ? rows : []) {
      const rowId = readString(row, 'documentId');
      if (targetUid === uid && documentId && rowId === documentId) continue;

      const slug = readString(row, 'slug');
      if (toRouteSlug(slug, targetKind) !== route) continue;

      return {
        kind: targetKind,
        name: readString(row, 'name') ?? '(untitled)',
        slug: slug ?? route,
      };
    }
  }
  return null;
}

export async function findDealPageCollision(
  strapi: Core.Strapi,
  uid: IdentityUid,
  dealRoute: string,
  documentId: string | undefined,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<{ kind: IdentityKind; name: string } | null> {
  for (const targetUid of IDENTITY_UIDS) {
    const targetKind = KIND_BY_UID[targetUid];
    for (let page = 0; page < NAME_SCAN_MAX_PAGES; page += 1) {
      const rows: unknown = await strapi.documents(targetUid).findMany({
        locale,
        fields: ['documentId', 'name'],
        sort: [{ id: 'asc' }],
        limit: NAME_SCAN_PAGE,
        start: page * NAME_SCAN_PAGE,
      });
      const list = Array.isArray(rows) ? rows : [];
      for (const row of list) {
        const rowId = readString(row, 'documentId');
        if (targetUid === uid && documentId && rowId === documentId) continue;

        const name = readString(row, 'name');
        if (entityDealPageSlug(name) === dealRoute) {
          return { kind: targetKind, name: name ?? '(untitled)' };
        }
      }
      if (list.length < NAME_SCAN_PAGE) break;
    }
  }
  return null;
}

export async function findActiveRedirectCollision(
  strapi: Core.Strapi,
  route: string,
): Promise<{ from: string; to: string } | null> {
  const rows: unknown = await strapi
    .documents('api::redirect.redirect' as any)
    .findMany({
      filters: { active: true } as any,
      fields: ['from', 'to'] as any,
      limit: 2000,
    });
  const routeKey = `/${route}`.toLowerCase();

  for (const row of Array.isArray(rows) ? rows : []) {
    const from = readString(row, 'from');
    if (!from) continue;
    const normalized = from
      .trim()
      .split(/[?#]/, 1)[0]!
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '');
    const fromKey = (normalized.startsWith('/') ? normalized : `/${normalized}`)
      .toLowerCase();
    if (fromKey === routeKey) {
      return { from, to: readString(row, 'to') ?? '(unknown target)' };
    }
  }
  return null;
}
