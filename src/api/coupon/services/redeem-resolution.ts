// Offer REDEEM RESOLUTION: the gateway-only resolver's shared-secret
// authorization and id patterns. One of the modules split out of the
// coupon controller (see ../controllers/custom.ts).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { enabledContentLocaleCodesSync } from '../../../translation/locales/registry';
import { textDirectionFor } from '../../../translation/locales/resolve';

export const REDEEM_DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;

export const REDEEM_UIDS = {
  coupon: 'api::coupon.coupon',
  deal: 'api::deal.deal',
} as const;

export type RedeemEntityType = keyof typeof REDEEM_UIDS;

const REDEEM_COMMON_FIELDS = [
  'title',
  'code',
  'affiliateLink',
  'expiresAt',
  'scheduledAt',
  'contentStatus',
  'updatedAt',
  'couponType',
] as const;

const REDEEM_PRESENTATION_FIELDS = ['title'] as const;
const REDEEM_NAMED_RELATION = { fields: ['name'] } as const;
const REDEEM_POPULATE = {
  uniqueCouponPool: { fields: ['name'] },
  stores: REDEEM_NAMED_RELATION,
  brands: REDEEM_NAMED_RELATION,
  banks: REDEEM_NAMED_RELATION,
} as const;
const REDEEM_PRESENTATION_POPULATE = {
  stores: REDEEM_NAMED_RELATION,
  brands: REDEEM_NAMED_RELATION,
  banks: REDEEM_NAMED_RELATION,
} as const;

export function requestedRedeemLocale(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CONTENT_LOCALE;
  }
  if (value === DEFAULT_CONTENT_LOCALE) return DEFAULT_CONTENT_LOCALE;
  return typeof value === 'string' &&
    enabledContentLocaleCodesSync().includes(value)
    ? value
    : null;
}

function firstNamedRelation(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function hasNamedRelation(value: unknown): boolean {
  const relation = firstNamedRelation(value);
  return Boolean(
    relation &&
      typeof relation === 'object' &&
      typeof (relation as { name?: unknown }).name === 'string' &&
      (relation as { name: string }).name.trim(),
  );
}

/**
 * Resolve redemption as two deliberately separate concerns. Codes, pools,
 * affiliate URLs and lifecycle always come from English; only the visible
 * title and merchant name may come from the requested localized row.
 */
export async function resolveRedeemDocument(
  strapi: Core.Strapi,
  input: {
    entityType: RedeemEntityType;
    documentId: string;
    locale: string;
  },
): Promise<Record<string, unknown> | null> {
  const uid = REDEEM_UIDS[input.entityType];
  const source = await strapi.documents(uid as any).findOne({
    documentId: input.documentId,
    locale: DEFAULT_CONTENT_LOCALE,
    status: 'published',
    fields: [...REDEEM_COMMON_FIELDS],
    populate: REDEEM_POPULATE,
  } as any);
  if (!source) return null;

  let presentation: Record<string, unknown> | null = null;
  if (input.locale !== DEFAULT_CONTENT_LOCALE) {
    presentation = (await strapi.documents(uid as any).findOne({
      documentId: input.documentId,
      locale: input.locale,
      status: 'published',
      fields: [...REDEEM_PRESENTATION_FIELDS],
      populate: REDEEM_PRESENTATION_POPULATE,
    } as any)) as Record<string, unknown> | null;
  }

  const merged = { ...(source as Record<string, unknown>) };
  if (typeof presentation?.title === 'string' && presentation.title.trim()) {
    merged.title = presentation.title;
  }
  for (const relation of ['stores', 'brands', 'banks'] as const) {
    if (hasNamedRelation(presentation?.[relation])) {
      merged[relation] = presentation?.[relation];
    }
  }
  return {
    ...merged,
    locale: input.locale,
    dir: textDirectionFor(input.locale),
  };
}

function secureSecretMatch(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

export function isRedeemResolverAuthorized(ctx: any): boolean {
  const secret = process.env.ISR_ADMIN_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const authorization = String(ctx.get('authorization') || '');
  return secureSecretMatch(authorization, `Bearer ${secret}`);
}
