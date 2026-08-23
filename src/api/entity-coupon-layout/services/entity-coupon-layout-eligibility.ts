// Entity coupon-layout ELIGIBILITY: which coupons may be selected, and
// validation of a submitted selection against the live set (with the
// dropped-selection self-heal report). Split out of the service coordinator
// (see ./entity-coupon-layout.ts).
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import {
  configFor,
  CouponLayoutError,
  type LayoutSelection,
} from './entity-coupon-layout-parse';
import {
  minimalCoupon,
  relationIds,
  type CouponProjection,
} from './entity-coupon-layout-repository';

export async function eligibleCoupons(
  strapi: Core.Strapi,
  config: ReturnType<typeof configFor>,
  entityDocumentId: string,
  ids?: readonly string[],
  options: {
    search?: string;
    start?: number;
    limit?: number;
    sort?: 'newest' | 'title';
    filters?: Record<string, any>;
  } = {},
): Promise<CouponProjection[]> {
  const filters =
    options.filters ??
    eligibleCouponFilters(config, entityDocumentId, ids, options.search);
  const sort =
    options.sort === 'title'
      ? [{ title: 'asc' }, { id: 'asc' }]
      : [{ publishedOn: 'desc' }, { id: 'desc' }];
  const coupons: any[] = await strapi
    .documents('api::coupon.coupon')
    .findMany({
      filters,
      fields: [
        'documentId',
        'title',
        'couponType',
        'badge',
        'expiresAt',
        'publishedOn',
      ] as any,
      sort: sort as any,
      start: options.start ?? 0,
      limit: options.limit ?? Math.max(ids?.length ?? 0, 200),
    });
  return coupons.map(minimalCoupon);
}

export function eligibleCouponFilters(
  config: ReturnType<typeof configFor>,
  entityDocumentId: string,
  ids?: readonly string[],
  search?: string,
): Record<string, any> {
  const filters: Record<string, any> = {
    $and: [
      { [config.relation]: { documentId: entityDocumentId } },
      publishedOnlyFilters(),
    ],
  };
  if (ids) filters.$and.push({ documentId: { $in: [...ids] } });
  if (search) {
    filters.$and.push({ title: { $containsi: search } });
  }
  return filters;
}

export type DroppedSelection = {
  documentId: string;
  title: string | null;
};

/** documentIds currently persisted on either curated relation. */
export function storedSelectionIds(entity: any): Set<string> {
  return new Set([
    ...relationIds(entity, 'topPickCoupons'),
    ...relationIds(entity, 'orderedCoupons'),
  ]);
}

/**
 * Titles of the currently persisted picks, so a dropped one can be named in
 * the response. The stored relation is the only place the title survives — by
 * definition the coupon is no longer in the eligible projection.
 */
export function storedSelectionTitles(entity: any): Map<string, string> {
  const titles = new Map<string, string>();
  for (const field of ['topPickCoupons', 'orderedCoupons']) {
    for (const coupon of Array.isArray(entity?.[field]) ? entity[field] : []) {
      const id = coupon?.documentId;
      if (typeof id === 'string' && id && typeof coupon?.title === 'string') {
        titles.set(id, coupon.title);
      }
    }
  }
  return titles;
}

/**
 * Resolve a selection to live Coupons, self-healing entries that have since
 * gone stale.
 *
 * A Coupon can expire or be unpublished after it was curated. The layout GET
 * populates relations with no visibility predicate, so the dialog still shows
 * it and sends it straight back — which used to make the ENTIRE entity
 * unsaveable until an editor worked out by hand which row was dead.
 *
 * So the two cases are separated:
 *  - already in the stored selection → drop it, report it, let the save
 *    proceed. This is ordinary Coupon lifecycle, and the five-minute cron
 *    (`removeInactiveCuratedOfferRelations`) already strips exactly these
 *    rows on its own schedule — the save simply stops being the one path that
 *    refuses to participate.
 *  - newly added by this request → still reject. The candidate list only ever
 *    offers live Coupons, so an ineligible one here means a race or a client
 *    bug, and swallowing it would hide a real defect.
 */
export async function validateEligibleSelection(
  strapi: Core.Strapi,
  config: ReturnType<typeof configFor>,
  entityDocumentId: string,
  selection: LayoutSelection,
  alreadySaved: ReadonlySet<string>,
  storedTitles: ReadonlyMap<string, string> = new Map(),
): Promise<{
  byId: Map<string, CouponProjection>;
  selection: LayoutSelection;
  dropped: DroppedSelection[];
}> {
  const requested = [
    ...new Set([
      ...selection.topPickCouponIds,
      ...selection.orderedCouponIds,
    ]),
  ];
  if (requested.length === 0) {
    return { byId: new Map(), selection, dropped: [] };
  }
  const coupons = await eligibleCoupons(
    strapi,
    config,
    entityDocumentId,
    requested,
  );
  const byId = new Map(coupons.map((coupon) => [coupon.documentId, coupon]));
  const unavailable = requested.filter((id) => !byId.has(id));

  const newlyAdded = unavailable.filter((id) => !alreadySaved.has(id));
  if (newlyAdded.length > 0) {
    throw new CouponLayoutError(
      'Selections must be live Coupons related to this entity.',
      400,
      'UNAVAILABLE_COUPONS',
      { documentIds: newlyAdded },
    );
  }

  if (unavailable.length === 0) {
    return { byId, selection, dropped: [] };
  }

  const stale = new Set(unavailable);
  return {
    byId,
    selection: {
      topPickCouponIds: selection.topPickCouponIds.filter(
        (id) => !stale.has(id),
      ),
      orderedCouponIds: selection.orderedCouponIds.filter(
        (id) => !stale.has(id),
      ),
    },
    dropped: unavailable.map((id) => ({
      documentId: id,
      title: storedTitles.get(id) ?? null,
    })),
  };
}
