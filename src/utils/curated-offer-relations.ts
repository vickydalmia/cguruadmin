import { AsyncLocalStorage } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from './content-status';
import { isLiveOffer } from './offer-visibility';
import {
  toRouteSlug,
  type IdentityKind,
} from './route-normalization';

type OfferUid = 'api::coupon.coupon' | 'api::deal.deal';

type CuratedOfferRelation = {
  sourceUid: string;
  field: string;
  targetUid: OfferUid;
};

export type CuratedOfferCleanupResult = {
  removedSelections: number;
  affectedPaths: string[];
  requiresFullRevalidation: boolean;
};

/**
 * Every curated Coupon/Deal relation used by the Homepage, Deal of the Day,
 * and entity Top Picks. Nested relation-picker requests use the immediate
 * component UID rather than the owning single type, so this is also the
 * precise allow-list for the request-scoped query filter below.
 */
export const CURATED_OFFER_RELATIONS: readonly CuratedOfferRelation[] = [
  { sourceUid: 'home.hero-product', field: 'deal', targetUid: 'api::deal.deal' },
  { sourceUid: 'home.top-offer-item', field: 'coupon', targetUid: 'api::coupon.coupon' },
  { sourceUid: 'home.exclusive-item', field: 'coupon', targetUid: 'api::coupon.coupon' },
  { sourceUid: 'home.coupon-card-item', field: 'coupon', targetUid: 'api::coupon.coupon' },
  { sourceUid: 'home.offer-list', field: 'offers', targetUid: 'api::coupon.coupon' },
  { sourceUid: 'home.explore-offer-tab', field: 'offers', targetUid: 'api::coupon.coupon' },
  { sourceUid: 'home.deal-list', field: 'deals', targetUid: 'api::deal.deal' },
  { sourceUid: 'home.explore-tab', field: 'deals', targetUid: 'api::deal.deal' },
  { sourceUid: 'deal-day.section-heading', field: 'deals', targetUid: 'api::deal.deal' },
  { sourceUid: 'deal-day.store-tab', field: 'deals', targetUid: 'api::deal.deal' },
  { sourceUid: 'deal-day.telegram-deals', field: 'deals', targetUid: 'api::deal.deal' },
  { sourceUid: 'api::store.store', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
  { sourceUid: 'api::brand.brand', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
  {
    sourceUid: 'api::category.category',
    field: 'topPickCoupons',
    targetUid: 'api::coupon.coupon',
  },
  { sourceUid: 'api::bank.bank', field: 'topPickCoupons', targetUid: 'api::coupon.coupon' },
] as const;

const relationTargetBySourceAndField = new Map(
  CURATED_OFFER_RELATIONS.map((relation) => [
    `${relation.sourceUid}\0${relation.field}`,
    relation.targetUid,
  ]),
);

const liveRelationRequest = new AsyncLocalStorage<{ targetUid: OfferUid }>();

const ENTITY_KIND_BY_UID: Readonly<Record<string, IdentityKind>> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

function curatedSourcePath(sourceUid: string, row: any): string | null {
  if (sourceUid.startsWith('home.')) return '/';
  if (sourceUid.startsWith('deal-day.')) return '/deal-of-the-day/';

  const kind = ENTITY_KIND_BY_UID[sourceUid];
  if (!kind) return null;
  const slug = toRouteSlug(row?.slug, kind);
  return slug ? `/${slug}/` : null;
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Matches both Content Manager relation endpoints:
 *   /content-manager/relations/:model/:targetField
 *   /content-manager/relations/:model/:id/:targetField
 */
export function curatedOfferTargetForRelationPath(path: string): OfferUid | null {
  const parts = path.split('/').filter(Boolean).map(safelyDecode);
  const relationsIndex = parts.findIndex(
    (part, index) => part === 'relations' && parts[index - 1] === 'content-manager',
  );
  if (relationsIndex < 0) return null;

  const sourceUid = parts[relationsIndex + 1];
  const field = parts.at(-1);
  if (!sourceUid || !field || parts.length - relationsIndex < 3) return null;

  return relationTargetBySourceAndField.get(`${sourceUid}\0${field}`) ?? null;
}

export function runWithCuratedOfferRelationFilter<T>(
  targetUid: OfferUid,
  callback: () => T,
): T {
  return liveRelationRequest.run({ targetUid }, callback);
}

function appendLiveOfferWhere(event: any): void {
  const request = liveRelationRequest.getStore();
  const eventUid = event?.model?.uid ?? event?.model;
  if (!request || (eventUid && eventUid !== request.targetUid)) return;

  event.params ??= {};
  const liveWhere = publishedOnlyFilters(new Date());
  const currentWhere = event.params.where;
  event.params.where = currentWhere
    ? { $and: [currentWhere, liveWhere] }
    : liveWhere;
}

/**
 * The relation controller uses Query Engine (not Document Service), including
 * a separate count query for pagination. Filter both operations so dropdown
 * results, search, totals, and "load more" all describe the same live set.
 */
export function registerCuratedOfferRelationQueryFilter(strapi: Core.Strapi): void {
  strapi.db.lifecycles.subscribe({
    models: ['api::coupon.coupon', 'api::deal.deal'],
    beforeFindMany: appendLiveOfferWhere,
    beforeCount: appendLiveOfferWhere,
  });
}

/**
 * Remove non-live offers from curated component/entity relations themselves.
 * Query Engine relation updates preserve the remaining many-way ordering and
 * work for both to-one and to-many fields.
 */
export async function removeInactiveCuratedOfferRelations(
  strapi: Core.Strapi,
  now = new Date(),
): Promise<CuratedOfferCleanupResult> {
  let removedSelections = 0;
  let requiresFullRevalidation = false;
  const affectedPaths = new Set<string>();

  for (const relation of CURATED_OFFER_RELATIONS) {
    const query = strapi.db.query(relation.sourceUid as any);
    const isEntitySource = Boolean(ENTITY_KIND_BY_UID[relation.sourceUid]);
    const rows = await query.findMany({
      select: isEntitySource ? ['id', 'slug'] : ['id'],
      populate: {
        [relation.field]: {
          select: ['id', 'documentId', 'contentStatus', 'expiresAt'],
        },
      },
    } as any);

    for (const row of rows as any[]) {
      const selected = Array.isArray(row?.[relation.field])
        ? row[relation.field]
        : row?.[relation.field]
          ? [row[relation.field]]
          : [];
      const inactiveIds = selected
        .filter((offer: any) => !isLiveOffer(offer, now))
        .map((offer: any) => offer.id)
        .filter((id: unknown): id is string | number =>
          typeof id === 'string' || typeof id === 'number',
        );

      if (inactiveIds.length === 0) continue;

      await query.update({
        where: { id: row.id },
        data: {
          [relation.field]: {
            disconnect: inactiveIds,
          },
        },
      } as any);
      removedSelections += inactiveIds.length;

      const path = curatedSourcePath(relation.sourceUid, row);
      if (path) {
        affectedPaths.add(path);
      } else {
        requiresFullRevalidation = true;
      }
    }
  }

  return {
    removedSelections,
    affectedPaths: [...affectedPaths],
    requiresFullRevalidation,
  };
}
