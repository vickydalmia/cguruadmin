import type { Core } from '@strapi/strapi';
import { toRouteSlug, type IdentityKind } from './route-normalization';

// CURATED OFFER RELATIONS — schema indexing. Derives (and caches per strapi
// instance) every curated coupon/deal relation from the loaded schemas.
// Request-scoped live filtering lives in ./curated-offer-live-filter,
// inactive-offer cleanup in ./curated-offer-cleanup, and displayed-Top-Pick
// reconciliation in ./curated-offer-top-picks.

export type OfferUid = 'api::coupon.coupon' | 'api::deal.deal';

export type CuratedOfferRelation = {
  sourceUid: string;
  field: string;
  targetUid: OfferUid;
};

const OFFER_UIDS: readonly OfferUid[] = ['api::coupon.coupon', 'api::deal.deal'];

function isOfferUid(target: unknown): target is OfferUid {
  return OFFER_UIDS.includes(target as OfferUid);
}

export type CuratedOfferRelationIndex = {
  relations: readonly CuratedOfferRelation[];
  targetBySourceAndField: ReadonlyMap<string, OfferUid>;
};

const curatedRelationCache = new WeakMap<object, CuratedOfferRelationIndex>();

/**
 * Every curated Coupon/Deal relation used by the Homepage, Deal of the Day,
 * headers, and entity Top Picks — derived from the loaded schemas so the list
 * can never drift from the components again:
 *
 *   - every component relation targeting Coupon/Deal is curated (nested
 *     relation-picker requests use the immediate component UID rather than the
 *     owning single type, so this is also the precise allow-list for the
 *     request-scoped query filter below), and
 *   - every unidirectional content-type relation targeting Coupon/Deal is
 *     curated (Top Picks / Ordered Coupons); the catalog inverses all carry
 *     `mappedBy` and stay unfiltered.
 *
 * Derivation is lazy on purpose: this module is imported by config/cron-tasks
 * and the middleware factory before a `strapi` instance exists.
 */
export function getCuratedOfferRelationIndex(strapi: Core.Strapi): CuratedOfferRelationIndex {
  const cached = curatedRelationCache.get(strapi);
  if (cached) return cached;

  const relations: CuratedOfferRelation[] = [];

  for (const [sourceUid, component] of Object.entries(
    (strapi.components ?? {}) as Record<string, any>,
  )) {
    for (const [field, attribute] of Object.entries(
      (component?.attributes ?? {}) as Record<string, any>,
    )) {
      if (attribute?.type === 'relation' && isOfferUid(attribute.target)) {
        relations.push({ sourceUid, field, targetUid: attribute.target });
      }
    }
  }

  for (const [sourceUid, contentType] of Object.entries(
    (strapi.contentTypes ?? {}) as Record<string, any>,
  )) {
    if (!sourceUid.startsWith('api::')) continue;
    for (const [field, attribute] of Object.entries(
      (contentType?.attributes ?? {}) as Record<string, any>,
    )) {
      if (
        attribute?.type === 'relation' &&
        isOfferUid(attribute.target) &&
        !attribute.mappedBy &&
        !attribute.inversedBy
      ) {
        relations.push({ sourceUid, field, targetUid: attribute.target });
      }
    }
  }

  const index: CuratedOfferRelationIndex = {
    relations,
    targetBySourceAndField: new Map(
      relations.map((relation) => [
        `${relation.sourceUid}\0${relation.field}`,
        relation.targetUid,
      ]),
    ),
  };
  curatedRelationCache.set(strapi, index);
  return index;
}

export function getCuratedOfferRelations(
  strapi: Core.Strapi,
): readonly CuratedOfferRelation[] {
  return getCuratedOfferRelationIndex(strapi).relations;
}

export const ENTITY_KIND_BY_UID: Readonly<Record<string, IdentityKind>> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

export function curatedSourcePath(sourceUid: string, row: any): string | null {
  if (sourceUid.startsWith('home.')) return '/';
  if (sourceUid.startsWith('header.')) return '/';

  const kind = ENTITY_KIND_BY_UID[sourceUid];
  if (!kind) return null;
  const slug = toRouteSlug(row?.slug, kind);
  return slug ? `/${slug}/` : null;
}

export async function curatedSourcePaths(
  strapi: Core.Strapi,
  sourceUid: string,
  row: any,
): Promise<string[]> {
  if (sourceUid.startsWith('deal-day.')) {
    const { entityTemplateOwnerSlugs } = await import(
      '../api/site-configuration/services/entity-template-owners'
    );
    return (await entityTemplateOwnerSlugs(strapi, 'dealTemplate')).map(
      (slug) => `/${slug}/`,
    );
  }
  if (sourceUid.startsWith('festival.')) {
    const { entityTemplateOwnerSlugs } = await import(
      '../api/site-configuration/services/entity-template-owners'
    );
    return (
      await entityTemplateOwnerSlugs(strapi, 'independenceDayTemplate')
    ).map((slug) => `/${slug}/`);
  }
  const path = curatedSourcePath(sourceUid, row);
  return path ? [path] : [];
}
