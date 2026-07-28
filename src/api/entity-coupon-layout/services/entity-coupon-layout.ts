import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';

import { insertIsrOutboxEvent } from '../../../isr-outbox/store';
import { SITEMAP_INDEX_PATH } from '../../../isr-outbox/payload';
import { wakeIsrOutbox } from '../../../isr-outbox/runtime';
import { purgeResponseCaches } from '../../../middlewares/cache';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { toRouteSlug } from '../../../utils/route-normalization';

export const ENTITY_COUPON_LAYOUT_ACTION =
  'admin::entity-coupon-layout.manage';
export const ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES = {
  section: 'settings',
  displayName: 'Manage entity coupon layout',
  uid: 'entity-coupon-layout.manage',
  // This is an Administration Panel permission, not a standalone Strapi
  // plugin. `admin` is the installed core plugin that owns settings actions.
  pluginName: 'admin',
  category: 'content management',
  subCategory: 'coupon layout',
} as const;
export const TOP_PICK_LIMIT = 4;
export const ORDERED_COUPON_LIMIT = 10;
export const DISPLAYED_TOP_PICK_COUNT = 2;
export const PREVIEW_COUPON_LIMIT = 30;

const KIND_CONFIG = {
  store: {
    uid: 'api::store.store',
    table: 'stores',
    relation: 'stores',
    publicPath: 'stores',
  },
  brand: {
    uid: 'api::brand.brand',
    table: 'brands',
    relation: 'brands',
    publicPath: 'brands',
  },
  category: {
    uid: 'api::category.category',
    table: 'categories',
    relation: 'categories',
    publicPath: 'categories',
  },
  bank: {
    uid: 'api::bank.bank',
    table: 'banks',
    relation: 'banks',
    publicPath: 'banks',
  },
} as const;

export type EntityCouponLayoutKind = keyof typeof KIND_CONFIG;

export class CouponLayoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CouponLayoutError';
  }
}

type LayoutSelection = {
  topPickCouponIds: string[];
  orderedCouponIds: string[];
};

type CouponProjection = {
  id: number;
  documentId: string;
  title: string;
  couponType?: string | null;
  badge?: string | null;
  expiresAt?: string | null;
  publishedOn?: string | null;
};

function configFor(kind: unknown) {
  const normalized = String(kind ?? '').trim().toLowerCase();
  const config = KIND_CONFIG[normalized as EntityCouponLayoutKind];
  if (!config) {
    throw new CouponLayoutError(
      'Entity kind must be store, brand, category or bank.',
      400,
      'INVALID_KIND',
    );
  }
  return {
    kind: normalized as EntityCouponLayoutKind,
    ...config,
  };
}

function documentId(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 255) {
    throw new CouponLayoutError(
      'A valid entity documentId is required.',
      400,
      'INVALID_DOCUMENT_ID',
    );
  }
  return normalized;
}

function idArray(
  value: unknown,
  field: string,
  limit: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new CouponLayoutError(
      `${field} must be an array.`,
      400,
      'INVALID_SELECTION',
      { field },
    );
  }
  const result = value.map((entry) => String(entry ?? '').trim());
  if (result.some((entry) => !entry || entry.length > 255)) {
    throw new CouponLayoutError(
      `${field} contains an invalid Coupon documentId.`,
      400,
      'INVALID_SELECTION',
      { field },
    );
  }
  if (result.length > limit) {
    throw new CouponLayoutError(
      `${field} accepts at most ${limit} Coupons.`,
      400,
      'LIMIT_EXCEEDED',
      { field, limit },
    );
  }
  if (new Set(result).size !== result.length) {
    throw new CouponLayoutError(
      `${field} contains the same Coupon more than once.`,
      400,
      'DUPLICATE_SELECTION',
      { field },
    );
  }
  return result;
}

export function parseLayoutSelection(value: unknown): LayoutSelection {
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const topPickCouponIds = idArray(
    body.topPickCouponIds,
    'topPickCouponIds',
    TOP_PICK_LIMIT,
  );
  const orderedCouponIds = idArray(
    body.orderedCouponIds,
    'orderedCouponIds',
    ORDERED_COUPON_LIMIT,
  );
  const displayed = new Set(
    topPickCouponIds.slice(0, DISPLAYED_TOP_PICK_COUNT),
  );
  const overlap = orderedCouponIds.filter((id) => displayed.has(id));
  if (overlap.length > 0) {
    throw new CouponLayoutError(
      'A displayed Top Pick cannot also be an Ordered Coupon. Buffer slots 3–4 may overlap.',
      400,
      'DISPLAYED_OVERLAP',
      { documentIds: overlap },
    );
  }
  return { topPickCouponIds, orderedCouponIds };
}

function minimalCoupon(coupon: any): CouponProjection {
  return {
    id: Number(coupon.id),
    documentId: String(coupon.documentId),
    title: String(coupon.title ?? ''),
    couponType:
      typeof coupon.couponType === 'string' ? coupon.couponType : null,
    badge: typeof coupon.badge === 'string' ? coupon.badge : null,
    expiresAt:
      coupon.expiresAt instanceof Date
        ? coupon.expiresAt.toISOString()
        : typeof coupon.expiresAt === 'string'
          ? coupon.expiresAt
          : null,
    publishedOn:
      coupon.publishedOn instanceof Date
        ? coupon.publishedOn.toISOString()
        : typeof coupon.publishedOn === 'string'
          ? coupon.publishedOn
          : null,
  };
}

function relationIds(entity: any, field: string): string[] {
  return (Array.isArray(entity?.[field]) ? entity[field] : [])
    .map((coupon: any) => coupon?.documentId)
    .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id));
}

function versionOf(entity: any): string {
  const value = entity?.updatedAt;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Entity has no usable updatedAt version.');
  }
  return date.toISOString();
}

/**
 * Every surface a Coupon-layout change invalidates.
 *
 * `pagePaths` uses `toRouteSlug`, not a bare slash-trim. Stored slugs
 * legitimately carry an owned type namespace (`store/amazon`) while the
 * rendered page lives at `/amazon/`, so trimming alone emitted
 * `/store/amazon/` — a durable outbox event invalidating a path that does not
 * exist, leaving the real page stale. Every other producer of this path
 * normalizes the same way (curated-offer-relations `curatedSourcePath`,
 * isr-outbox/scopes).
 *
 * Coupon Top Picks and Ordered Coupons are not Product Deal curation. The
 * `-deals` page derives its Top Deals exclusively from live Deals, so a Coupon
 * layout save must never invalidate the Deal page or Deal response cache.
 */
export function couponLayoutInvalidation(
  config: { kind: EntityCouponLayoutKind; publicPath: string },
  rawSlug: unknown,
): { pagePaths: string[]; cachePaths: string[] } {
  const publicSlug = toRouteSlug(rawSlug, config.kind);
  // The response cache is keyed on Koa's ctx.path, which preserves the
  // percent-encoding of the incoming URL — and the frontend builds these
  // requests as `encodeURIComponent(sourceSlug)` (entity-offers-request.ts),
  // one path segment carrying the RAW stored slug. So the purge prefix must be
  // that same encoded form: for a stored slug `store/amazon` the cached key is
  // `/api/stores/store%2Famazon/coupons?...`, and a raw `store/amazon` prefix
  // matches nothing, silently leaving the stale ordering for the ISR
  // re-render to consume.
  const encodedSlug = encodeURIComponent(String(rawSlug ?? ''));
  return {
    // The sitemap index is listed alongside the pages, matching what
    // createOutboxPayload emits whenever a scope sets `sitemap` — the write
    // bumps `updated_at`, which is this entity's published lastmod.
    pagePaths: publicSlug
      ? [`/${publicSlug}/`, SITEMAP_INDEX_PATH]
      : [],
    cachePaths: [`/api/${config.publicPath}/${encodedSlug}/coupons`],
  };
}

async function readEntity(strapi: Core.Strapi, kind: unknown, rawDocumentId: unknown) {
  const config = configFor(kind);
  const resolvedDocumentId = documentId(rawDocumentId);
  const entity = await strapi.db.query(config.uid as any).findOne({
    where: { documentId: resolvedDocumentId },
    select: ['id', 'documentId', 'slug', 'updatedAt'],
    populate: {
      topPickCoupons: {
        select: ['id', 'documentId', 'title', 'couponType', 'badge', 'expiresAt', 'publishedOn'],
      },
      orderedCoupons: {
        select: ['id', 'documentId', 'title', 'couponType', 'badge', 'expiresAt', 'publishedOn'],
      },
    },
  } as any);
  if (!entity) {
    throw new CouponLayoutError('Entity not found.', 404, 'NOT_FOUND');
  }
  return { config, entity, documentId: resolvedDocumentId };
}

async function eligibleCoupons(
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

function eligibleCouponFilters(
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
function storedSelectionIds(entity: any): Set<string> {
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
function storedSelectionTitles(entity: any): Map<string, string> {
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
async function validateEligibleSelection(
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

export function createEntityCouponLayoutService({
  strapi,
}: {
  strapi: Core.Strapi;
}) {
  const getLayout = async (kind: unknown, rawDocumentId: unknown) => {
    const { config, entity } = await readEntity(
      strapi,
      kind,
      rawDocumentId,
    );
    const topPickCoupons = (entity.topPickCoupons ?? []).map(minimalCoupon);
    const orderedCoupons = (entity.orderedCoupons ?? []).map(minimalCoupon);
    return {
      kind: config.kind,
      documentId: entity.documentId,
      slug: entity.slug,
      version: versionOf(entity),
      topPickCoupons,
      orderedCoupons,
      counts: {
        topPicks: topPickCoupons.length,
        ordered: orderedCoupons.length,
      },
    };
  };
  return {
    get: getLayout,

    async candidates(
      kind: unknown,
      rawDocumentId: unknown,
      query: Record<string, unknown>,
    ) {
      const { config, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
      const search = String(query.search ?? '').trim().slice(0, 120);
      const sort = query.sort === 'title' ? 'title' : 'newest';
      const filters = eligibleCouponFilters(
        config,
        entityDocumentId,
        undefined,
        search,
      );
      const [results, total] = await Promise.all([
        eligibleCoupons(strapi, config, entityDocumentId, undefined, {
          search,
          sort,
          start: (page - 1) * pageSize,
          limit: pageSize,
          filters,
        }),
        strapi.documents('api::coupon.coupon').count({ filters }),
      ]);
      return {
        results,
        pagination: {
          page,
          pageSize,
          pageCount: Math.max(1, Math.ceil(total / pageSize)),
          total,
        },
      };
    },

    async preview(
      kind: unknown,
      rawDocumentId: unknown,
      body: unknown,
    ) {
      const { config, entity, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const requestedSelection = parseLayoutSelection(body);
      // A preview writes nothing, so it must never be the thing that fails on
      // stale saved picks — it is how an editor SEES the current state.
      const { byId: selected, selection } = await validateEligibleSelection(
        strapi,
        config,
        entityDocumentId,
        requestedSelection,
        storedSelectionIds(entity),
      );
      const filters = eligibleCouponFilters(config, entityDocumentId);
      const [automatic, total] = await Promise.all([
        eligibleCoupons(
          strapi,
          config,
          entityDocumentId,
          undefined,
          {
            // At most fourteen selected Coupons can occupy the beginning of
            // the automatic sequence. Fetch enough beyond the 30 visible rows
            // to construct the authoritative preview without loading the
            // entity's complete membership.
            limit:
              PREVIEW_COUPON_LIMIT +
              TOP_PICK_LIMIT +
              ORDERED_COUPON_LIMIT +
              DISPLAYED_TOP_PICK_COUNT,
            filters,
          },
        ),
        strapi.documents('api::coupon.coupon').count({
          filters,
        }),
      ]);
      const automaticById = new Map(
        automatic.map((coupon) => [coupon.documentId, coupon]),
      );
      const topPicks = selection.topPickCouponIds
        .map((id) => selected.get(id))
        .filter(Boolean) as CouponProjection[];

      // Fill empty displayed slots the way the storefront does, which means
      // skipping anything the editor put in the ordered head:
      // build-unified-entity-page-view filters `orderedCouponIds` out of its
      // automatic candidates before calling selectEntityTopPicks. Without this
      // the preview could promote an ordered Coupon into a Top Pick slot AND
      // remove it from the main list — the one place the real page renders it.
      const orderedSelectionIds = new Set(selection.orderedCouponIds);
      for (const coupon of automatic) {
        if (topPicks.length >= DISPLAYED_TOP_PICK_COUNT) break;
        if (orderedSelectionIds.has(coupon.documentId)) continue;
        if (!topPicks.some((item) => item.documentId === coupon.documentId)) {
          topPicks.push(coupon);
        }
      }

      // The storefront renders NO Top Picks section below two picks
      // (selectEntityTopPicks: `if (selected.length < 2) return []`), leaving
      // those Coupons in the main list. An entity with a single eligible
      // Coupon must preview that way too, or the preview shows a section the
      // page will not render and hides the row where it actually appears.
      const displayedPicks =
        topPicks.length >= DISPLAYED_TOP_PICK_COUNT
          ? topPicks.slice(0, DISPLAYED_TOP_PICK_COUNT)
          : [];
      const displayed = new Set(
        displayedPicks.map((coupon) => coupon.documentId),
      );
      const ordered = selection.orderedCouponIds
        .filter((id) => !displayed.has(id))
        .map((id) => selected.get(id) ?? automaticById.get(id))
        .filter(Boolean) as CouponProjection[];
      const orderedIds = new Set(ordered.map((coupon) => coupon.documentId));
      const main = [
        ...ordered,
        ...automatic.filter(
          (coupon) =>
            !displayed.has(coupon.documentId) &&
            !orderedIds.has(coupon.documentId),
        ),
      ];
      return {
        topPicks: displayedPicks,
        coupons: main.slice(0, PREVIEW_COUPON_LIMIT),
        // Full live membership, including Coupons displayed as Top Picks.
        total,
      };
    },

    async replace(
      kind: unknown,
      rawDocumentId: unknown,
      body: unknown,
    ) {
      const { config, entity, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const input =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const requestedVersion = String(input.version ?? '');
      const currentVersion = versionOf(entity);
      if (!requestedVersion || requestedVersion !== currentVersion) {
        throw new CouponLayoutError(
          'This Coupon layout changed after you opened it. Reload before saving.',
          409,
          'VERSION_CONFLICT',
          { currentVersion },
        );
      }
      const requestedSelection = parseLayoutSelection(input);
      const {
        byId: selected,
        selection,
        dropped,
      } = await validateEligibleSelection(
        strapi,
        config,
        entityDocumentId,
        requestedSelection,
        storedSelectionIds(entity),
        storedSelectionTitles(entity),
      );
      const topPickIds = selection.topPickCouponIds.map(
        (id) => selected.get(id)!.id,
      );
      const orderedIds = selection.orderedCouponIds.map(
        (id) => selected.get(id)!.id,
      );
      const now = new Date();
      const eventKey = randomUUID();
      const { pagePaths, cachePaths } = couponLayoutInvalidation(
        config,
        entity.slug,
      );
      if (pagePaths.length === 0) {
        strapi.log.warn(
          `[coupon-layout] ${config.uid} ${entityDocumentId} has an unroutable slug `
          + `(${JSON.stringify(entity.slug)}); skipping page invalidation.`,
        );
      }

      const outbox = await strapi.db.transaction(
        async ({
          trx,
          onCommit,
        }: {
          trx: any;
          onCommit: (callback: () => void) => void;
        }) => {
          // Row lock, then re-read the version INSIDE it — the check before
          // the transaction is only a fast path and cannot close the
          // read-modify-write window on its own.
          //
          // knex emits no lock clause on SQLite, which is the default
          // DATABASE_CLIENT for local dev, so there this degrades to the same
          // non-atomic compare. Production runs Postgres, where it is a real
          // FOR UPDATE.
          const locked = await trx(config.table)
            .where({ id: entity.id })
            .select(['id', 'updated_at'])
            .forUpdate()
            .first();
          const lockedVersion = locked?.updated_at
            ? new Date(locked.updated_at).toISOString()
            : '';
          if (lockedVersion !== requestedVersion) {
            throw new CouponLayoutError(
              'This Coupon layout changed after you opened it. Reload before saving.',
              409,
              'VERSION_CONFLICT',
              { currentVersion: lockedVersion },
            );
          }
          await strapi.db.query(config.uid as any).update({
            where: { id: entity.id },
            data: {
              topPickCoupons: { set: topPickIds },
              orderedCoupons: { set: orderedIds },
            },
          } as any);
          const touched = await trx(config.table)
            .where({ id: entity.id })
            .update({ updated_at: now });
          if (Number(touched) !== 1) {
            throw new Error('Entity disappeared while saving Coupon layout.');
          }
          const event = await insertIsrOutboxEvent(trx, {
            eventKey,
            // `sitemap` because the write bumps `updated_at`, which is the
            // value the sitemap publishes as lastmod for this entity.
            payload: { paths: pagePaths, scopes: ['sitemap'] },
            reason: `${config.uid} coupon layout update`,
          });
          onCommit(() => {
            purgeResponseCaches(cachePaths);
            wakeIsrOutbox();
          });
          return event;
        },
      );

      return {
        ...(await getLayout(config.kind, entityDocumentId)),
        // Non-empty when a saved pick had gone stale and was self-healed out
        // of the selection. The dialog names them so the editor is never
        // silently left with a different layout than the one they submitted.
        dropped,
        refresh: {
          outboxId: outbox.id,
          state: 'queued',
        },
      };
    },
  };
}

export default createEntityCouponLayoutService;
