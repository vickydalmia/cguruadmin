import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from './queue';

// Maps a Strapi document change to the pages that must rebuild — the
// "what rebuilds when" matrix in cguru-ui/docs/deployment-runbook.md §3.

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
const ENTITY_UIDS: Record<string, string> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};
const RELEVANT_ACTIONS = new Set(['create', 'update', 'delete', 'publish', 'unpublish', 'discardDraft']);

// Public URLs are flat: strip an optional type prefix from source slugs
// (mirror of cguru-ui/src/lib/entity-links.ts#normalizeTypedSlug).
function publicSlug(value: string | null | undefined, kind: string): string | null {
  const slug = value?.trim().replace(/^\/+|\/+$/g, '');
  if (!slug) return null;
  const [namespace, ...rest] = slug.split('/');
  const plural = kind === 'category' ? 'categories' : `${kind}s`;
  if (rest.length > 0 && (namespace === kind || namespace === plural)) {
    return rest.join('/');
  }
  return slug;
}

const RELATION_KINDS: Array<[field: string, kind: string]> = [
  ['stores', 'store'],
  ['brands', 'brand'],
  ['categories', 'category'],
  ['banks', 'bank'],
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
      ...(uid === 'api::deal.deal' ? { primaryStore: { fields: ['slug'] } } : {}),
    } as any,
  });
  if (!doc) return null;

  const slugs = new Set<string>();
  for (const [field, kind] of RELATION_KINDS) {
    for (const related of doc[field] ?? []) {
      const slug = publicSlug(related?.slug, kind);
      if (slug) slugs.add(slug);
    }
  }
  const primary = publicSlug(doc.primaryStore?.slug, 'store');
  if (primary) slugs.add(primary);

  return [...slugs];
}

/**
 * Pre-fetch (BEFORE next()) for offer changes — for deletes the doc is gone
 * afterwards and its relations are unknowable, so a failed pre-read must
 * escalate to full. For updates the post-write computeScope still reads the
 * after-relations, so a failed pre-read only loses REMOVED-relation coverage
 * (reconciled by the nightly full) — escalating every transient read hiccup
 * during routine edits to a 5k-page full sweep is how revalidate storms start.
 */
export async function preDeleteScope(
  strapi: Core.Strapi,
  uid: string,
  documentId: string | undefined,
  action: string,
): Promise<ScopeRequest | null> {
  if (!OFFER_UIDS.has(uid) || !documentId) return null;
  const fallback = (): ScopeRequest | null =>
    action === 'delete' ? { full: true } : null;
  try {
    const slugs = await offerRelationSlugs(strapi, uid as any, documentId);
    return slugs ? { slugs: withDealLandingSlug(uid, slugs), homepage: true } : fallback();
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

  if (uid === 'api::homepage.homepage') return { homepage: true };
  if (uid === DOTD_PAGE_UID) return { slugs: [DEAL_OF_THE_DAY_SLUG] };
  if (uid === ABOUT_PAGE_UID) return { slugs: [ABOUT_PAGE_SLUG] };
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
    };
  }
  // A job changes both the listing and one or more build routes. Creation,
  // deletion, or a slug edit also changes the route manifest/sitemap, so use
  // the existing full rebuild safety path for every editor operation.
  if (uid === JOB_UID) return { full: true };
  if (uid === ERROR_PAGE_UID) return { slugs: [...ERROR_DOCUMENT_SLUGS] };
  if (CHROME_UIDS.has(uid)) return { full: true };

  if (OFFER_UIDS.has(uid)) {
    // delete is handled via preDeleteScope; if we get here without one, be safe.
    if (action === 'delete') return { full: true };
    if (!documentId) return { full: true };
    const slugs = await offerRelationSlugs(strapi, uid as any, documentId);
    if (slugs === null) return { full: true };
    // An offer with no entity relations only shows via curation surfaces.
    return { slugs: withDealLandingSlug(uid, slugs), homepage: true };
  }

  const kind = ENTITY_UIDS[uid];
  if (kind) {
    // Routes list + sitemap change; S3 page deletion needs a full sync.
    if (action === 'create' || action === 'delete') return { full: true };
    if (!documentId) return { full: true };
    const doc: any = await strapi.documents(uid as any).findOne({
      documentId,
      fields: ['slug'] as any,
    });
    const slug = publicSlug(doc?.slug, kind);
    if (!slug) return { full: true };
    // The deal landing page bakes store pill labels/logos and category tab
    // names/icons into its HTML — same reason entity edits carry homepage.
    const slugs =
      kind === 'store' || kind === 'category'
        ? [...new Set([slug, DEAL_OF_THE_DAY_SLUG])]
        : [slug];
    return { slugs, homepage: true };
  }

  return null; // unrelated content type (pools, users…)
}
