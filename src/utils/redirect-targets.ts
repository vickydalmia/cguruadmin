// Target classification for the redirect validator: what a `to` value is
// allowed to be, and whether a `from` path shadows a live entity page.
// Split out of redirect-validation.ts, which keeps the write orchestration.
import type { Core } from '@strapi/strapi';
import { IDENTITY_UIDS } from './identity-uids';
import {
  routeSlugCandidates,
  toRouteSlug,
  type IdentityKind,
} from './route-normalization';
import {
  entityDealPageSlug,
  parseEntityDealPageSlug,
} from '../api/entity-deal-page/services/entity-deal-route';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { foldPathKey, normalizeRedirectPath } from './redirect-paths';
import { readString } from './row-fields';

const ENTITY_CANDIDATE_LIMIT = 25;
const ENTITY_NAME_SCAN_PAGE = 500;

const KIND_BY_UID: Record<string, IdentityKind> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

export type RedirectTarget =
  | { kind: 'internal'; raw: string; path: string; key: string }
  | { kind: 'external'; raw: string }
  | { kind: 'invalid'; reason: string };

/**
 * Classify a `to` value. Deliberately strict about what may end up in a
 * Location header:
 *
 *  - `//evil.example` is rejected. Browsers read a leading `//` as
 *    protocol-relative, so it is an off-site redirect that LOOKS like a path —
 *    an open redirect an editor can create by typo.
 *  - Any backslash is rejected. WHATWG URL parsing folds `\` to `/` in
 *    http(s) contexts, so `/\evil.example` resolves to
 *    `https://evil.example/` — the same open redirect, spelled so it slips
 *    past a naive `//` check.
 *  - Anything that is neither an absolute http(s) URL nor a rooted path is
 *    rejected rather than guessed at.
 *  - Control characters are rejected: a raw CR/LF in a Location header is
 *    response splitting.
 */
export function classifyTarget(value: unknown): RedirectTarget {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { kind: 'invalid', reason: 'is empty' };

  // Escaped explicitly: a raw CR/LF reaching a Location header is response
  // splitting, and a literal control byte in the source is invisible in review.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return {
      kind: 'invalid',
      reason: 'contains a line break or control character, which is not allowed in a redirect target',
    };
  }

  // Before the external-URL branch: browsers treat "\" as "/" when resolving
  // a Location header, so a backslash target is an off-site redirect however
  // it is spelled ("/\evil.example" resolves to https://evil.example/).
  if (raw.includes('\\')) {
    return {
      kind: 'invalid',
      reason:
        `contains a backslash ("${raw}"). Browsers treat "\\" as "/", so this ` +
        `value would send visitors to a DIFFERENT site, not a page on this one. ` +
        `Use forward slashes only — "/path" for an internal page, or the full ` +
        `"https://…" address for an external one`,
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      new URL(raw);
    } catch {
      return { kind: 'invalid', reason: `is not a valid absolute URL ("${raw}")` };
    }
    return { kind: 'external', raw };
  }

  if (raw.startsWith('//')) {
    return {
      kind: 'invalid',
      reason:
        `starts with "//" ("${raw}"), which browsers read as a link to ANOTHER ` +
        `site, not a path on this one. Write "/${raw.replace(/^\/+/, '')}" for an ` +
        `internal page, or the full "https://…" address for an external one`,
    };
  }

  if (!raw.startsWith('/')) {
    return {
      kind: 'invalid',
      reason:
        `must be either a path on this site starting with "/" (for example ` +
        `"/nike/") or a full "https://…" address, but it is "${raw}"`,
    };
  }

  const path = normalizeRedirectPath(raw);
  return { kind: 'internal', raw, path, key: foldPathKey(path) };
}

/**
 * A live store/brand/category/bank whose public page is served at this path.
 *
 * Matching is case-insensitive (`$eqi`, an exact comparison — no LIKE
 * wildcards leak in) and re-confirmed in JS through toRouteSlug(), the same
 * normalisation the frontend uses to turn a stored "stores/amazon" into the
 * route "amazon". A raw string compare would miss that form and let a redirect
 * shadow the page anyway.
 */
export async function findLiveEntity(
  strapi: Core.Strapi,
  path: string,
): Promise<{
  kind: IdentityKind;
  name: string;
  slug: string;
  entityDealPage?: boolean;
} | null> {
  const route = path.replace(/^\/+/, '');
  if (!route) return null;
  const routeKey = route.toLowerCase();

  const findRoute = async (candidateRoute: string) => {
    const candidateKey = candidateRoute.toLowerCase();
    for (const targetUid of IDENTITY_UIDS) {
      const kind = KIND_BY_UID[targetUid];
      if (!kind) continue;

      // The three stored forms that all route to `candidateRoute`.
      const candidates = routeSlugCandidates(candidateRoute, kind);

      const rows: unknown = await strapi.documents(targetUid).findMany({
        locale: DEFAULT_CONTENT_LOCALE,
        filters: { $or: candidates.map((candidate) => ({ slug: { $eqi: candidate } })) } as any,
        fields: ['name', 'slug'],
        limit: ENTITY_CANDIDATE_LIMIT,
      });

      for (const row of Array.isArray(rows) ? rows : []) {
        const slug = readString(row, 'slug');
        if (toRouteSlug(slug, kind).toLowerCase() !== candidateKey) continue;
        return {
          kind,
          name: readString(row, 'name') ?? '(untitled)',
          slug: slug ?? candidateRoute,
        };
      }
    }
    return null;
  };

  const direct = await findRoute(route);
  if (direct) return direct;

  if (!parseEntityDealPageSlug(route)) return null;
  for (const targetUid of IDENTITY_UIDS) {
    const kind = KIND_BY_UID[targetUid];
    if (!kind) continue;
    let start = 0;
    while (true) {
      const rows: unknown = await strapi.documents(targetUid).findMany({
        locale: DEFAULT_CONTENT_LOCALE,
        fields: ['name', 'slug'],
        sort: [{ id: 'asc' }],
        start,
        limit: ENTITY_NAME_SCAN_PAGE,
      });
      const list = Array.isArray(rows) ? rows : [];
      for (const row of list) {
        const name = readString(row, 'name') ?? '(untitled)';
        if (entityDealPageSlug(name)?.toLowerCase() !== routeKey) continue;
        return {
          kind,
          name,
          slug: readString(row, 'slug') ?? route,
          entityDealPage: true,
        };
      }
      if (list.length < ENTITY_NAME_SCAN_PAGE) break;
      start += list.length;
    }
  }
  return null;
}
