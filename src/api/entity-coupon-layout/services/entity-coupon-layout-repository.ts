// Entity coupon-layout REPOSITORY: entity reads, coupon projections and
// version derivation. Split out of the service coordinator (see
// ./entity-coupon-layout.ts).
import type { Core } from '@strapi/strapi';
import {
  CouponLayoutError,
  configFor,
  documentId,
  type EntityCouponLayoutKind,
} from './entity-coupon-layout-parse';

export type CouponProjection = {
  id: number;
  documentId: string;
  title: string;
  couponType?: string | null;
  badge?: string | null;
  expiresAt?: string | null;
  publishedOn?: string | null;
};

export function minimalCoupon(coupon: any): CouponProjection {
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

export function relationIds(entity: any, field: string): string[] {
  return (Array.isArray(entity?.[field]) ? entity[field] : [])
    .map((coupon: any) => coupon?.documentId)
    .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id));
}

export function versionOf(entity: any): string {
  const value = entity?.updatedAt;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Entity has no usable updatedAt version.');
  }
  return date.toISOString();
}

export async function readEntity(strapi: Core.Strapi, kind: unknown, rawDocumentId: unknown) {
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
