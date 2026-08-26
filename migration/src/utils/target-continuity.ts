/**
 * Phase 12 needs a populated Deal target only when the active source contains
 * an importable Deal. Coupons-only country profiles legitimately have zero on
 * both sides and must be allowed to continue to their Coupon backfills.
 */
export function hasStaleEmptyDealTarget(
  importableSourceDealCount: number,
  targetDealCount: number,
): boolean {
  return importableSourceDealCount > 0 && targetDealCount === 0;
}
