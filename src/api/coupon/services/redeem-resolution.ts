// Offer REDEEM RESOLUTION: the gateway-only resolver's shared-secret
// authorization and id patterns. One of the modules split out of the
// coupon controller (see ../controllers/custom.ts).
import { createHash, timingSafeEqual } from 'node:crypto';

export const REDEEM_DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;

export const REDEEM_UIDS = {
  coupon: 'api::coupon.coupon',
  deal: 'api::deal.deal',
} as const;

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
