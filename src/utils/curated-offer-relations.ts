import { AsyncLocalStorage } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from './content-status';
import { isLiveOffer } from './offer-visibility';
import {
  routeSlugCandidates,
  toRouteSlug,
  type IdentityKind,
} from './route-normalization';

export type OfferUid = 'api::coupon.coupon' | 'api::deal.deal';

export type CuratedOfferRelation = {
  sourceUid: string;
  field: string;
  targetUid: OfferUid;
};

export type CuratedOfferCleanupResult = {
  removedSelections: number;
  affectedPaths: string[];
  requiresFullRevalidation: boolean;
};

const OFFER_UIDS: readonly OfferUid[] = ['api::coupon.coupon', 'api::deal.deal'];

function isOfferUid(target: unknown): target is OfferUid {
  return OFFER_UIDS.includes(target as OfferUid);
}

type CuratedOfferRelationIndex = {
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
function getCuratedOfferRelationIndex(strapi: Core.Strapi): CuratedOfferRelationIndex {
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
  if (sourceUid.startsWith('header.')) return '/';

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
 * Axios leaves literal percent signs untouched while encoding spaces in the
 * relation combobox query (for example `100%%20Whey`). Depending on the URL
 * parser, the encoded tail can then survive in `_q` and fail an otherwise
 * exact title match. Preserve literal percent signs, decode valid escapes, and
 * ignore accidental leading/trailing whitespace.
 */
export function normalizeRelationSearch(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const escapedLiteralPercents = value.replace(/%(?![0-9a-f]{2})/gi, '%25');
  return safelyDecode(escapedLiteralPercents).trim();
}

/**
 * Matches both Content Manager relation endpoints:
 *   /content-manager/relations/:model/:targetField
 *   /content-manager/relations/:model/:id/:targetField
 */
function relationPathParts(
  path: string,
): { sourceUid: string; field: string } | null {
  const parts = path.split('/').filter(Boolean).map(safelyDecode);
  const relationsIndex = parts.findIndex(
    (part, index) => part === 'relations' && parts[index - 1] === 'content-manager',
  );
  if (relationsIndex < 0) return null;

  const sourceUid = parts[relationsIndex + 1];
  const field = parts.at(-1);
  if (!sourceUid || !field || parts.length - relationsIndex < 3) return null;

  return { sourceUid, field };
}

export function isContentManagerRelationPath(path: string): boolean {
  return relationPathParts(path) !== null;
}

export function curatedOfferTargetForRelationPath(
  strapi: Core.Strapi,
  path: string,
): OfferUid | null {
  const parsed = relationPathParts(path);
  if (!parsed) return null;

  return (
    getCuratedOfferRelationIndex(strapi).targetBySourceAndField.get(
      `${parsed.sourceUid}\0${parsed.field}`,
    ) ?? null
  );
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
  changedOffers?: Readonly<Partial<Record<OfferUid, readonly string[]>>>,
): Promise<CuratedOfferCleanupResult> {
  let removedSelections = 0;
  let requiresFullRevalidation = false;
  const affectedPaths = new Set<string>();

  for (const relation of getCuratedOfferRelations(strapi)) {
    const changedDocumentIds = changedOffers?.[relation.targetUid];
    if (changedOffers && (!changedDocumentIds || changedDocumentIds.length === 0)) {
      continue;
    }
    const query = strapi.db.query(relation.sourceUid as any);
    const isEntitySource = Boolean(ENTITY_KIND_BY_UID[relation.sourceUid]);
    const rows = await query.findMany({
      ...(changedDocumentIds
        ? {
            where: {
              [relation.field]: {
                documentId: { $in: [...changedDocumentIds] },
              },
            },
          }
        : {}),
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

/**
 * How many Top Picks the storefront actually renders. Selections past this are
 * expiry buffers — invisible until an earlier pick stops being live.
 * Mirrors TOP_PICK_DISPLAYED in the admin Coupon layout feature.
 */
const DISPLAYED_TOP_PICKS = 2;

const TOP_PICK_ENTITY_UIDS = Object.keys(ENTITY_KIND_BY_UID);

/**
 * Keep a DISPLAYED Top Pick out of `orderedCoupons`.
 *
 * Top Picks 3-4 are expiry buffers and may legitimately sit in the ordered
 * head at the same time — a displayed pick may not, because the storefront
 * removes displayed picks from the main list, which would silently punch a
 * hole in the editorial order.
 *
 * This is enforced by REPAIR rather than by write validation, deliberately:
 *
 *   - The rule is positional, and `resultingRelations` cannot resolve the
 *     resulting ORDER of a relation patch (it keeps first occurrences and
 *     ignores Strapi's before/end anchors), so a validator would misjudge any
 *     drag-reorder.
 *   - `removeInactiveCuratedOfferRelations` above writes through Query Engine,
 *     bypassing the document-service middleware. When it drops an expired pick
 *     and promotes a buffer that is also ordered, it creates exactly this
 *     state — and a validator would then reject EVERY later save of that
 *     entity, including edits unrelated to Coupons.
 *
 * Lifecycle cleanup passes affected entity paths so buffer promotions are
 * repaired immediately without scanning every entity. The nightly call omits
 * that target and performs the full reconciliation safety pass.
 *
 * NOTE: this edits editorial data without the editor asking, so every removal
 * is logged. If someone deliberately puts a displayed Top Pick into Ordered
 * Coupons it will be removed by reconciliation, and the log is the audit
 * trail.
 */
export async function removeDisplayedTopPicksFromOrdered(
  strapi: Core.Strapi,
  targetPaths?: readonly string[],
): Promise<CuratedOfferCleanupResult> {
  let removedSelections = 0;
  let requiresFullRevalidation = false;
  const affectedPaths = new Set<string>();

  for (const sourceUid of TOP_PICK_ENTITY_UIDS) {
    const query = strapi.db.query(sourceUid as any);
    const kind = ENTITY_KIND_BY_UID[sourceUid];
    const slugs = targetPaths
      ?.flatMap((path) => {
        const route = path.replace(/^\/+|\/+$/g, '');
        return route && kind ? routeSlugCandidates(route, kind) : [];
      });
    if (targetPaths && (!slugs || slugs.length === 0)) continue;
    // Query Engine populate preserves link-table order when no explicit sort
    // is given (getJoinTableOrderBy in @strapi/database), so index 0 and 1 are
    // the displayed picks.
    const rows = await query.findMany({
      ...(slugs ? { where: { slug: { $in: slugs } } } : {}),
      select: ['id', 'slug'],
      populate: {
        topPickCoupons: { select: ['id', 'documentId'] },
        orderedCoupons: { select: ['id', 'documentId'] },
      },
    } as any);

    for (const row of rows as any[]) {
      const topPicks = Array.isArray(row?.topPickCoupons)
        ? row.topPickCoupons
        : [];
      const ordered = Array.isArray(row?.orderedCoupons)
        ? row.orderedCoupons
        : [];
      if (topPicks.length === 0 || ordered.length === 0) continue;

      const orderedIds = new Set(
        ordered.map((coupon: any) => coupon?.id).filter(Boolean),
      );
      const conflicting = topPicks
        .slice(0, DISPLAYED_TOP_PICKS)
        .filter((coupon: any) => coupon?.id && orderedIds.has(coupon.id));
      if (conflicting.length === 0) continue;

      await query.update({
        where: { id: row.id },
        data: {
          orderedCoupons: {
            disconnect: conflicting.map((coupon: any) => coupon.id),
          },
        },
      } as any);
      removedSelections += conflicting.length;

      const path = curatedSourcePath(sourceUid, row);
      if (path) {
        affectedPaths.add(path);
      } else {
        requiresFullRevalidation = true;
      }

      strapi.log.info({
        event: 'content.displayed_top_pick_removed_from_ordered',
        sourceUid,
        path,
        entityId: row.id,
        coupons: conflicting.map((coupon: any) => coupon.documentId ?? coupon.id),
      });
    }
  }

  return {
    removedSelections,
    affectedPaths: [...affectedPaths],
    requiresFullRevalidation,
  };
}
