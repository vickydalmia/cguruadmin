// OFFER RELATION SCOPES: entity-relation mapping for offer writes and the
// pre-delete scope capture. One of the modules split out of scopes.ts,
// which keeps the computeScope coordinator.
import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from './types';
import {
  toRouteSlug,
  type IdentityKind,
} from '../utils/route-normalization';
import { entityDealPageSlug } from '../api/entity-deal-page/services/entity-deal-route';
import { DOCUMENT_WRITE_ACTIONS } from '../constants/document-write';
import { withOfferLandingSlugs } from './scope-static-pages';

export const OFFER_UIDS = new Set(['api::coupon.coupon', 'api::deal.deal']);

export const ENTITY_UIDS: Record<string, IdentityKind> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

// Public URLs are flat: strip an optional type prefix from source slugs
// (mirror of cguru-ui/src/lib/entity-links.ts#normalizeTypedSlug).
export function publicSlug(
  value: string | null | undefined,
  kind: IdentityKind,
): string | null {
  return toRouteSlug(value, kind) || null;
}

export const RELATION_KINDS: Array<[field: string, kind: IdentityKind]> = [
  ['stores', 'store'],
  ['brands', 'brand'],
  ['categories', 'category'],
  ['banks', 'bank'],
];

export const ENTITY_TYPES: Array<[uid: string, kind: IdentityKind]> = [
  ['api::store.store', 'store'],
  ['api::brand.brand', 'brand'],
  ['api::category.category', 'category'],
  ['api::bank.bank', 'bank'],
];

type OfferRelationScope = {
  slugs: string[];
  optionalSlugs: string[];
};

export async function offerRelationScope(
  strapi: Core.Strapi,
  uid: 'api::coupon.coupon' | 'api::deal.deal',
  documentId: string,
): Promise<OfferRelationScope | null> {
  const doc: any = await strapi.documents(uid).findOne({
    documentId,
    populate: {
      stores: { fields: ['name', 'slug'] },
      brands: { fields: ['name', 'slug'] },
      categories: { fields: ['name', 'slug'] },
      banks: { fields: ['name', 'slug'] },
    } as any,
  });
  if (!doc) return null;

  const numericId = Number(doc.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  const detailKind = uid === 'api::coupon.coupon' ? 'coupon' : 'deal';
  const slugs = new Set<string>([`${detailKind}/${numericId}`]);
  const entitySlugs = new Set<string>();
  const entityDealSlugs = new Set<string>();
  for (const [field, kind] of RELATION_KINDS) {
    for (const related of doc[field] ?? []) {
      const slug = publicSlug(related?.slug, kind);
      if (slug) entitySlugs.add(slug);
      const dealSlug = entityDealPageSlug(related?.name);
      if (uid === 'api::deal.deal' && dealSlug) entityDealSlugs.add(dealSlug);
    }
  }
  // Query every entity-owned offer relation as well as the offer-owned
  // relation arrays above. `coupons`/`deals` are mappedBy relations on the
  // entities, while topPickCoupons/orderedCoupons are separate one-way
  // curated relations.
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
                { orderedCoupons: { documentId: { $eq: documentId } } },
              ],
            }
          : { deals: { documentId: { $eq: documentId } } };
      const entities: any[] = await strapi.documents(entityUid as any).findMany({
        filters: offerFilter as any,
        fields: ['name', 'slug'] as any,
      });
      return entities
        .map((entity) => ({
          slug: publicSlug(entity?.slug, kind),
          dealSlug: entityDealPageSlug(entity?.name),
        }))
        .filter((entity) => Boolean(entity.slug));
    }),
  );
  for (const entity of entityPages.flat()) {
    if (entity.slug) entitySlugs.add(entity.slug);
    if (uid === 'api::deal.deal' && entity.dealSlug) {
      entityDealSlugs.add(entity.dealSlug);
    }
  }
  for (const slug of entitySlugs) slugs.add(slug);

  return {
    slugs: [...slugs],
    optionalSlugs: [...entityDealSlugs],
  };
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
    const relationScope = await offerRelationScope(
      strapi,
      uid as any,
      documentId,
    );
    return relationScope
      ? {
          slugs: withOfferLandingSlugs(uid, relationScope.slugs),
          ...(relationScope.optionalSlugs.length > 0
            ? { optionalSlugs: relationScope.optionalSlugs }
            : {}),
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
