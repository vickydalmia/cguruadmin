import type { IsrOutboxPayload } from './types';

/** The gateway must still refresh inventory and confirm this route is absent. */
export function reconcileDeletedOfferRetry(
  payload: IsrOutboxPayload,
  reason: string,
  lastError: string | null,
): IsrOutboxPayload {
  const type = reason === 'api::coupon.coupon delete' ? 'coupon'
    : reason === 'api::deal.deal delete' ? 'deal' : null;
  if (!type || !payload.scopes?.includes('routes')) return payload;
  const path = lastError?.match(/^gateway skipped 1 path\(s\): (\/[^\s,]+)$/)?.[1];
  if (!path || !new RegExp(`^/${type}/[1-9]\\d*/$`).test(path)) return payload;
  if (!payload.paths?.includes(path) || payload.optionalPaths?.includes(path)) return payload;
  return { ...payload, optionalPaths: [...(payload.optionalPaths ?? []), path] };
}
