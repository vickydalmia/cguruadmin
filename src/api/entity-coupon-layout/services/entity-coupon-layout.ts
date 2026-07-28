import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';

import { insertIsrOutboxEvent } from '../../../isr-outbox/store';
import { wakeIsrOutbox } from '../../../isr-outbox/runtime';
import { purgeResponseCaches } from '../../../middlewares/cache';
import { publishedOnlyFilters } from '../../../utils/content-status';

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
  options: { search?: string; start?: number; limit?: number } = {},
): Promise<CouponProjection[]> {
  const filters: Record<string, any> = {
    $and: [
      { [config.relation]: { documentId: entityDocumentId } },
      publishedOnlyFilters(),
    ],
  };
  if (ids) filters.$and.push({ documentId: { $in: [...ids] } });
  if (options.search) {
    filters.$and.push({ title: { $containsi: options.search } });
  }
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
      sort: [{ publishedOn: 'desc' }, { id: 'desc' }] as any,
      start: options.start ?? 0,
      limit: options.limit ?? Math.max(ids?.length ?? 0, 200),
    });
  return coupons.map(minimalCoupon);
}

async function validateEligibleSelection(
  strapi: Core.Strapi,
  config: ReturnType<typeof configFor>,
  entityDocumentId: string,
  selection: LayoutSelection,
): Promise<Map<string, CouponProjection>> {
  const requested = [
    ...new Set([
      ...selection.topPickCouponIds,
      ...selection.orderedCouponIds,
    ]),
  ];
  if (requested.length === 0) return new Map();
  const coupons = await eligibleCoupons(
    strapi,
    config,
    entityDocumentId,
    requested,
  );
  const byId = new Map(coupons.map((coupon) => [coupon.documentId, coupon]));
  const unavailable = requested.filter((id) => !byId.has(id));
  if (unavailable.length > 0) {
    throw new CouponLayoutError(
      'Selections must be live Coupons related to this entity.',
      400,
      'UNAVAILABLE_COUPONS',
      { documentIds: unavailable },
    );
  }
  return byId;
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
      const filters: any = {
        $and: [
          { [config.relation]: { documentId: entityDocumentId } },
          publishedOnlyFilters(),
          ...(search ? [{ title: { $containsi: search } }] : []),
        ],
      };
      const [results, total] = await Promise.all([
        eligibleCoupons(strapi, config, entityDocumentId, undefined, {
          search,
          start: (page - 1) * pageSize,
          limit: pageSize,
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
      const { config, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const selection = parseLayoutSelection(body);
      const selected = await validateEligibleSelection(
        strapi,
        config,
        entityDocumentId,
        selection,
      );
      const automatic = await eligibleCoupons(
        strapi,
        config,
        entityDocumentId,
        undefined,
        { limit: 200 },
      );
      const automaticById = new Map(
        automatic.map((coupon) => [coupon.documentId, coupon]),
      );
      const topPicks = selection.topPickCouponIds
        .map((id) => selected.get(id))
        .filter(Boolean) as CouponProjection[];
      for (const coupon of automatic) {
        if (topPicks.length >= DISPLAYED_TOP_PICK_COUNT) break;
        if (!topPicks.some((item) => item.documentId === coupon.documentId)) {
          topPicks.push(coupon);
        }
      }
      const displayed = new Set(
        topPicks
          .slice(0, DISPLAYED_TOP_PICK_COUNT)
          .map((coupon) => coupon.documentId),
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
        topPicks: topPicks.slice(0, DISPLAYED_TOP_PICK_COUNT),
        coupons: main.slice(0, 30),
        total: main.length,
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
      const selection = parseLayoutSelection(input);
      const selected = await validateEligibleSelection(
        strapi,
        config,
        entityDocumentId,
        selection,
      );
      const topPickIds = selection.topPickCouponIds.map(
        (id) => selected.get(id)!.id,
      );
      const orderedIds = selection.orderedCouponIds.map(
        (id) => selected.get(id)!.id,
      );
      const now = new Date();
      const eventKey = randomUUID();
      const publicCouponPath = `/api/${config.publicPath}/${entity.slug}/coupons`;
      const publicPagePath = `/${String(entity.slug).replace(/^\/+|\/+$/g, '')}/`;

      const outbox = await strapi.db.transaction(
        async ({
          trx,
          onCommit,
        }: {
          trx: any;
          onCommit: (callback: () => void) => void;
        }) => {
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
            payload: { paths: [publicPagePath] },
            reason: `${config.uid} coupon layout update`,
          });
          onCommit(() => {
            purgeResponseCaches([publicCouponPath]);
            wakeIsrOutbox();
          });
          return event;
        },
      );

      return {
        ...(await getLayout(config.kind, entityDocumentId)),
        refresh: {
          outboxId: outbox.id,
          state: 'queued',
        },
      };
    },
  };
}

export default createEntityCouponLayoutService;
