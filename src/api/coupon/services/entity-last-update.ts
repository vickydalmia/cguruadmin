import type { Core } from '@strapi/strapi';

const FALLBACK_UPDATER = 'CouponzGuru Team';

const ENTITY_TABLES = {
  store: {
    entityTable: 'stores',
    linkTable: 'coupons_stores_lnk',
    entityColumn: 'store_id',
  },
  brand: {
    entityTable: 'brands',
    linkTable: 'coupons_brands_lnk',
    entityColumn: 'brand_id',
  },
  category: {
    entityTable: 'categories',
    linkTable: 'coupons_categories_lnk',
    entityColumn: 'category_id',
  },
  bank: {
    entityTable: 'banks',
    linkTable: 'coupons_banks_lnk',
    entityColumn: 'bank_id',
  },
} as const;

export type EntityLastUpdate = {
  updatedAt: string | null;
  updatedByName: string;
};

export type UpdateCandidate = {
  updatedAt?: unknown;
  firstname?: unknown;
  lastname?: unknown;
  username?: unknown;
};

function cleanNamePart(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function updaterName(candidate?: UpdateCandidate | null): string {
  if (!candidate) return FALLBACK_UPDATER;
  const fullName = [
    cleanNamePart(candidate.firstname),
    cleanNamePart(candidate.lastname),
  ]
    .filter(Boolean)
    .join(' ');
  return fullName || cleanNamePart(candidate.username) || FALLBACK_UPDATER;
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function selectLatestEntityUpdate(
  entity?: UpdateCandidate | null,
  coupon?: UpdateCandidate | null,
): EntityLastUpdate {
  const entityAt = isoDate(entity?.updatedAt);
  const couponAt = isoDate(coupon?.updatedAt);
  const couponIsLatest =
    couponAt !== null &&
    (entityAt === null || Date.parse(couponAt) > Date.parse(entityAt));
  const selected = couponIsLatest ? coupon : entity;

  return {
    updatedAt: couponIsLatest ? couponAt : entityAt,
    updatedByName: updaterName(selected),
  };
}

export async function resolveEntityLastUpdate(
  strapi: Core.Strapi,
  input: {
    entityType: string;
    entityId: number;
    entityUpdatedAt?: unknown;
  },
): Promise<EntityLastUpdate> {
  const config = ENTITY_TABLES[input.entityType as keyof typeof ENTITY_TABLES];
  const fallback = selectLatestEntityUpdate({
    updatedAt: input.entityUpdatedAt,
  });
  const connection = (strapi.db as any)?.connection;
  if (!config || !Number.isSafeInteger(input.entityId) || typeof connection !== 'function') {
    return fallback;
  }

  try {
    const cutoff = new Date().toISOString();
    const [entity, coupon] = await Promise.all([
      connection(`${config.entityTable} as e`)
        .leftJoin('admin_users as u', 'e.updated_by_id', 'u.id')
        .where('e.id', input.entityId)
        .select(
          'e.updated_at as updatedAt',
          'u.firstname',
          'u.lastname',
          'u.username',
        )
        .first(),
      connection(`${config.linkTable} as l`)
        .join('coupons as c', 'l.coupon_id', 'c.id')
        .leftJoin('admin_users as u', 'c.updated_by_id', 'u.id')
        .where(`l.${config.entityColumn}`, input.entityId)
        .andWhere('c.content_status', 'published')
        .andWhere((builder: any) =>
          builder.whereNull('c.expires_at').orWhere('c.expires_at', '>', cutoff),
        )
        .orderBy('c.updated_at', 'desc')
        .select(
          'c.updated_at as updatedAt',
          'u.firstname',
          'u.lastname',
          'u.username',
        )
        .first(),
    ]);

    return selectLatestEntityUpdate(
      entity ?? { updatedAt: input.entityUpdatedAt },
      coupon,
    );
  } catch (error) {
    strapi.log.warn(
      `[entity-last-update] attribution unavailable for ${input.entityType} ${input.entityId}: ${(error as Error)?.message}`,
    );
    return fallback;
  }
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  resolve(input: {
    entityType: string;
    entityId: number;
    entityUpdatedAt?: unknown;
  }) {
    return resolveEntityLastUpdate(strapi, input);
  },
});
