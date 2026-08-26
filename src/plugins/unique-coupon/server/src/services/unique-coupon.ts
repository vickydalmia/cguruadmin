import type { Core } from '@strapi/strapi';
import { getPoolStats } from './pool-stats';
import { importCodes } from './import-codes';
import { redeemCode } from './redeem-code';

// The thin unique-coupon service factory: PostgreSQL queries live in
// ./unique-coupon-sql, redemption in ./redeem-code, bulk import in
// ./import-codes, and pool statistics in ./pool-stats. Method names are the
// public service contract and stay unchanged; redeemCode receives this
// factory's `delay` so the retry cadence remains overridable per instance.
const uniqueCouponService = ({ strapi }: { strapi: Core.Strapi }) => ({
  // Non-async on purpose: returning the helper promise directly keeps the
  // single settlement boundary the pre-split inline implementations had.
  redeemCode(
    poolDocumentId: string,
    options: { activationId?: string | null; maxRetries?: number } = {},
  ) {
    return redeemCode(strapi, poolDocumentId, options, (ms) => this.delay(ms));
  },

  importCodes(poolDocumentId: string, codes: string[], batchSize = 100) {
    return importCodes(strapi, poolDocumentId, codes, batchSize);
  },

  getPoolStats(poolDocumentId: string) {
    return getPoolStats(strapi, poolDocumentId);
  },

  delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
});

export default uniqueCouponService;
