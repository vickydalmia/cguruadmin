import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from './queue';

// Maps a Strapi document change to the pages that must rebuild — the
// "what rebuilds when" matrix in cguru-ui/docs/deployment-runbook.md §3.

const CHROME_UIDS = new Set(['api::menu.menu', 'api::footer.footer', 'api::global.global']);
const OFFER_UIDS = new Set(['api::coupon.coupon', 'api::deal.deal']);
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
 * Pre-fetch (BEFORE next()) for offer deletes — afterwards the doc is gone
 * and its relations are unknowable. Returns null when the doc can't be read;
 * the caller then escalates to full (safe default).
 */
export async function preDeleteScope(
  strapi: Core.Strapi,
  uid: string,
  documentId: string | undefined,
): Promise<ScopeRequest | null> {
  if (!OFFER_UIDS.has(uid) || !documentId) return null;
  try {
    const slugs = await offerRelationSlugs(strapi, uid as any, documentId);
    return slugs ? { slugs, homepage: true } : { full: true };
  } catch {
    return { full: true };
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
  if (CHROME_UIDS.has(uid)) return { full: true };

  if (OFFER_UIDS.has(uid)) {
    // delete is handled via preDeleteScope; if we get here without one, be safe.
    if (action === 'delete') return { full: true };
    if (!documentId) return { full: true };
    const slugs = await offerRelationSlugs(strapi, uid as any, documentId);
    if (slugs === null) return { full: true };
    if (slugs.length === 0) return { homepage: true }; // offer with no relations only shows via curation
    return { slugs, homepage: true };
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
    return slug ? { slugs: [slug], homepage: true } : { full: true };
  }

  return null; // unrelated content type (tags, pools, users…)
}
