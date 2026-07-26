import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from './types';
import {
  toRouteSlug,
  type IdentityKind,
} from '../utils/route-normalization';

// Maps a Strapi document change to every rendered page that consumes it.

const CHROME_UIDS = new Set(['api::menu.menu', 'api::footer.footer', 'api::global.global']);
const OFFER_UIDS = new Set(['api::coupon.coupon', 'api::deal.deal']);

// The deal-of-the-day category page renders curated Deal sections (its
// single type may reference deals NOT tagged with the category), so every
// Deal change rebuilds it — the same stance as `homepage: true` on offer
// changes. One constant slug, deduped by the queue; coupons never render
// there and do not carry it.
const DEAL_OF_THE_DAY_SLUG = 'deal-of-the-day';
const DOTD_PAGE_UID = 'api::deal-of-the-day-page.deal-of-the-day-page';
// The About page is a standalone editorial route with no entity relations, so
// an edit rebuilds exactly one page. Its country cards read from the Footer
// single type, which is in CHROME_UIDS and already triggers a full rebuild.
const ABOUT_PAGE_UID = 'api::about-page.about-page';
const ABOUT_PAGE_SLUG = 'about-us';
const CAREER_PAGE_UID = 'api::career-page.career-page';
const JOB_UID = 'api::job.job';
const CAREER_PAGE_SLUG = 'careers';
// A redirect is evaluated by cguru-ui/src/middleware.ts on EVERY request,
// before routing — it is URL resolution itself, not page content. Nothing
// narrower than `full` is correct here: the affected URL set is not derivable
// from the row (a redirect names a path that has no page and therefore no
// slug in the scope vocabulary), and the change also moves the route manifest
// the ISR gateway admits paths against. Redirect edits are rare, so paying for
// a full regeneration is the cheap side of the trade. Two refinements ride on top:
// the gateway eagerly reloads its authored-redirect map when an event carries
// the "redirects" scope (every all=true event does — see the gateway's
// revalidationScopes), and note-only edits skip the sweep entirely via
// isRedirectNoteOnlyChange below.
const REDIRECT_UID = 'api::redirect.redirect';
const ERROR_PAGE_UID = 'api::error-page.error-page';
const ERROR_DOCUMENT_SLUGS = [
  'error-pages/400',
  'error-pages/403',
  'error-pages/404',
  'error-pages/405',
  'error-pages/414',
  'error-pages/416',
  'error-pages/500',
  'error-pages/501',
  'error-pages/502',
  'error-pages/503',
  'error-pages/504',
  'error-pages/template',
] as const;

function withDealLandingSlug(uid: string, slugs: string[]): string[] {
  if (uid !== 'api::deal.deal') return slugs;
  return [...new Set([...slugs, DEAL_OF_THE_DAY_SLUG])];
}
const ENTITY_UIDS: Record<string, IdentityKind> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};
const RELEVANT_ACTIONS = new Set([
  'create',
  'clone',
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

// Public URLs are flat: strip an optional type prefix from source slugs
// (mirror of cguru-ui/src/lib/entity-links.ts#normalizeTypedSlug).
function publicSlug(
  value: string | null | undefined,
  kind: IdentityKind,
): string | null {
  return toRouteSlug(value, kind) || null;
}

const RELATION_KINDS: Array<[field: string, kind: IdentityKind]> = [
  ['stores', 'store'],
  ['brands', 'brand'],
  ['categories', 'category'],
  ['banks', 'bank'],
];

const ENTITY_TYPES: Array<[uid: string, kind: IdentityKind]> = [
  ['api::store.store', 'store'],
  ['api::brand.brand', 'brand'],
  ['api::category.category', 'category'],
  ['api::bank.bank', 'bank'],
];

export async function offerRelationSlugs(
  strapi: Core.Strapi,
  uid: 'api::coupon.coupon' | 'api::deal.deal',
  documentId: string,
): Promise<string[] | null> {
  const doc: any = await strapi.documents(uid).findOne({
    documentId,
    populate: {
      stores: { fields: ['slug'] },
      brands: { fields: ['slug'] },
      categories: { fields: ['slug'] },
      banks: { fields: ['slug'] },
    } as any,
  });
  if (!doc) return null;

  const numericId = Number(doc.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  const detailKind = uid === 'api::coupon.coupon' ? 'coupon' : 'deal';
  const slugs = new Set<string>([`${detailKind}/${numericId}`]);
  for (const [field, kind] of RELATION_KINDS) {
    for (const related of doc[field] ?? []) {
      const slug = publicSlug(related?.slug, kind);
      if (slug) slugs.add(slug);
    }
  }
  // Query every entity-owned offer relation as well as the offer-owned
  // relation arrays above. `coupons`/`deals` are mappedBy relations on the
  // entities, while topPickCoupons is a separate one-way curated relation.
  // Reading both directions makes the rendered dependency explicit and
  // protects updates/deletes regardless of which side Strapi used to mutate
  // the join.
  const entityPages = await Promise.all(
    ENTITY_TYPES.map(async ([entityUid, kind]) => {
      const offerFilter =
        uid === 'api::coupon.coupon'
          ? {
              $or: [
                { coupons: { documentId: { $eq: documentId } } },
                { topPickCoupons: { documentId: { $eq: documentId } } },
              ],
            }
          : { deals: { documentId: { $eq: documentId } } };
      const entities: any[] = await strapi.documents(entityUid as any).findMany({
        filters: offerFilter as any,
        fields: ['slug'] as any,
      });
      return entities
        .map((entity) => publicSlug(entity?.slug, kind))
        .filter((slug): slug is string => Boolean(slug));
    }),
  );
  for (const slug of entityPages.flat()) slugs.add(slug);

  return [...slugs];
}

/**
 * Pre-fetch (BEFORE next()) for offer changes — for deletes the doc is gone
 * afterwards and its relations are unknowable. Updates need the old relations
 * too, so uncertainty must fail safe with a global invalidation.
 */
export async function preDeleteScope(
  strapi: Core.Strapi,
  uid: string,
  documentId: string | undefined,
  action: string,
): Promise<ScopeRequest | null> {
  if (!OFFER_UIDS.has(uid) || !documentId) return null;
  const fallback = (): ScopeRequest => ({
    full: true,
    refreshScopes: ['routes'],
  });
  try {
    const slugs = await offerRelationSlugs(strapi, uid as any, documentId);
    return slugs
      ? {
          slugs: withDealLandingSlug(uid, slugs),
          homepage: true,
          sitemap: true,
          refreshScopes: ['routes'],
        }
      : fallback();
  } catch (err: any) {
    strapi.log.warn(
      `[rebuild] pre-change relation read failed for ${uid} ${documentId} (${action}): ${err?.message ?? err}`
    );
    return fallback();
  }
}

/** Scope for a change, computed AFTER the write succeeded. */
export async function computeScope(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  documentId: string | undefined,
): Promise<ScopeRequest | null> {
  if (!RELEVANT_ACTIONS.has(action)) return null;

  if (uid === 'api::homepage.homepage') {
    return { homepage: true, sitemap: true };
  }
  if (uid === DOTD_PAGE_UID) {
    return { slugs: [DEAL_OF_THE_DAY_SLUG], sitemap: true };
  }
  if (uid === ABOUT_PAGE_UID) {
    return { slugs: [ABOUT_PAGE_SLUG], sitemap: true };
  }
  if (uid === CAREER_PAGE_UID) {
    const jobs: any[] = await strapi.documents(JOB_UID as any).findMany({
      filters: { isActive: true } as any,
      fields: ['slug'] as any,
    });
    return {
      slugs: [
        CAREER_PAGE_SLUG,
        ...jobs.map((job) => `careers/${job.slug}`).filter((slug) => !slug.endsWith('/undefined')),
      ],
      sitemap: true,
    };
  }
  // A job changes both the listing and one or more build routes. Creation,
  // deletion, or a slug edit also changes the route manifest/sitemap, so use
  // the existing full rebuild safety path for every editor operation.
  if (uid === JOB_UID) return { full: true, refreshScopes: ['routes'] };
  if (uid === REDIRECT_UID) {
    return { full: true, refreshScopes: ['routes', 'redirects'] };
  }
  if (uid === ERROR_PAGE_UID) {
    return {
      slugs: [...ERROR_DOCUMENT_SLUGS],
      refreshScopes: ['error-page'],
    };
  }
  if (CHROME_UIDS.has(uid)) {
    return { full: true, refreshScopes: ['chrome'] };
  }

  if (OFFER_UIDS.has(uid)) {
    // delete is handled via preDeleteScope; if we get here without one, be safe.
    if (action === 'delete') {
      return { full: true, refreshScopes: ['routes'] };
    }
    if (!documentId) return { full: true, refreshScopes: ['routes'] };
    const slugs = await offerRelationSlugs(strapi, uid as any, documentId);
    if (slugs === null) return { full: true, refreshScopes: ['routes'] };
    // An offer with no entity relations only shows via curation surfaces.
    return {
      slugs: withDealLandingSlug(uid, slugs),
      homepage: true,
      sitemap: true,
      refreshScopes: ['routes'],
    };
  }

  const kind = ENTITY_UIDS[uid];
  if (kind) {
    // Route membership and sitemap change on entity create/delete.
    if (action === 'create' || action === 'clone' || action === 'delete') {
      return { full: true, refreshScopes: ['routes'] };
    }
    if (!documentId) return { full: true, refreshScopes: ['routes'] };
    const doc: any = await strapi.documents(uid as any).findOne({
      documentId,
      fields: ['slug'] as any,
    });
    const slug = publicSlug(doc?.slug, kind);
    if (!slug) return { full: true, refreshScopes: ['routes'] };
    // The deal landing page bakes store pill labels/logos and category tab
    // names/icons into its HTML — same reason entity edits carry homepage.
    const slugs =
      kind === 'store' || kind === 'category'
        ? [...new Set([slug, DEAL_OF_THE_DAY_SLUG])]
        : [slug];
    return { slugs, homepage: true, sitemap: true };
  }

  return null; // unrelated content type (pools, users…)
}

// `note` is editor-facing metadata: it renders nowhere public (the public
// find projection excludes it), yet the redirect UID scopes to a FULL sweep
// above. The middleware reads these fields before the write and skips the
// rebuild when nothing material changed.
const REDIRECT_MATERIAL_FIELDS = ['from', 'to', 'statusCode', 'active'] as const;

/**
 * True when an update payload leaves every publicly-visible redirect field
 * untouched. Uncertainty must return false — the cost of a wrong `true` is a
 * silently stale redirect, while a wrong `false` merely keeps today's sweep.
 */
export function isRedirectNoteOnlyChange(
  before: Record<string, unknown> | null | undefined,
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!before || !data) return false;
  return REDIRECT_MATERIAL_FIELDS.every((field) => {
    if (!(field in data)) return true; // omitted from the payload → unchanged
    return (data[field] ?? null) === (before[field] ?? null);
  });
}
