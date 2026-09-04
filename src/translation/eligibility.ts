const OFFER_UIDS = new Set(['api::coupon.coupon', 'api::deal.deal']);

/** Scheduled offers are translated ahead of publication; only dead offers skip paid work. */
export function translationSourceIneligible(
  uid: string,
  source: any,
  now = new Date(),
): boolean {
  if (!OFFER_UIDS.has(uid)) return false;
  if (source?.contentStatus === 'expired') return true;
  if (!source?.expiresAt) return false;
  const expiresAt = new Date(source.expiresAt);
  return Number.isFinite(expiresAt.getTime()) && expiresAt <= now;
}
