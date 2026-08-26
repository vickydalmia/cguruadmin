import type { Core } from '@strapi/strapi';

/**
 * Per-request ceiling for uploadCodes. The admin client already posts in
 * batches of 2,000 (DEFAULT_CHUNK_SIZE in src/admin/features/unique-code/chunk-codes.ts);
 * this rejects hand-rolled API calls that would hold the pool import lock
 * for an unbounded number of rows in a single transaction.
 */
export const MAX_CODES_PER_REQUEST = 2000;

/**
 * Mirrors the activation id the redeem interstitial mints per click (a
 * `crypto.randomUUID()`, with or without dashes) and validates before putting
 * it in the URL fragment — see renderOfferRedeemHtml in
 * cguru-ui/isr-gateway/src/offer-redeem-route.ts. Anything else is ignored
 * rather than rejected: an unusable id must not cost the visitor their code,
 * it just means this activation is not replayable.
 */
const ACTIVATION_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

export function normalizeActivationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return ACTIVATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

type UniqueCouponContext = {
  request: { body: Record<string, unknown> };
  params: Record<string, string>;
  badRequest: (message: string) => unknown;
  notFound: (message: string) => unknown;
  send: (body: unknown, status?: number) => unknown;
};

const uniqueCouponController = ({ strapi }: { strapi: Core.Strapi }) => ({

  async redeem(ctx: UniqueCouponContext) {
    const { poolDocumentId, activationId } = ctx.request.body;

    if (!poolDocumentId) {
      return ctx.badRequest('poolDocumentId is required');
    }

    const result = await strapi
      .plugin('unique-coupon')
      .service('unique-coupon')
      .redeemCode(poolDocumentId, {
        activationId: normalizeActivationId(activationId),
      });

    if (result.success) {
      return ctx.send({ success: true, code: result.code });
    }

    if (result.error === 'NO_CODES_AVAILABLE') {
      return ctx.send({ success: false, error: result.error, message: result.message }, 200);
    }

    return ctx.send({ success: false, error: result.error, message: result.message }, 503);
  },

  async uploadCodes(ctx: UniqueCouponContext) {
    const { poolDocumentId, codes } = ctx.request.body;

    if (
      typeof poolDocumentId !== 'string' ||
      !poolDocumentId.trim() ||
      !Array.isArray(codes)
    ) {
      return ctx.badRequest('poolDocumentId and codes array required');
    }

    if (codes.length === 0) {
      return ctx.badRequest('Codes array cannot be empty');
    }

    // Matches the admin client's chunker (DEFAULT_CHUNK_SIZE in
    // src/admin/features/unique-code/chunk-codes.ts) — one import request holds the pool row
    // lock for the whole transaction, so a bounded chunk keeps that hold short.
    if (codes.length > MAX_CODES_PER_REQUEST) {
      return ctx.badRequest(
        `Maximum ${MAX_CODES_PER_REQUEST.toLocaleString('en-US')} codes per request — split larger imports into chunks of at most ${MAX_CODES_PER_REQUEST.toLocaleString('en-US')} codes`,
      );
    }

    const normalizedCodes: string[] = [];
    for (const [index, value] of codes.entries()) {
      if (typeof value !== 'string') {
        return ctx.badRequest(`Code ${index + 1} must be a string`);
      }
      const code = value.trim();
      if (!code) {
        return ctx.badRequest(`Code ${index + 1} cannot be blank`);
      }
      if (code.length > 255) {
        return ctx.badRequest(`Code ${index + 1} exceeds 255 characters`);
      }
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(code)) {
        return ctx.badRequest(`Code ${index + 1} contains control characters`);
      }
      normalizedCodes.push(code);
    }

    try {
      const result = await strapi
        .plugin('unique-coupon')
        .service('unique-coupon')
        .importCodes(poolDocumentId.trim(), normalizedCodes);

      return ctx.send({
        success: true,
        imported: result.imported,
        skipped: result.skipped,
        total: result.total,
      });
    } catch (error) {
      if ((error as any)?.code === 'POOL_NOT_FOUND') {
        return ctx.notFound('Pool not found');
      }
      throw error;
    }
  },

  async getStats(ctx: UniqueCouponContext) {
    const { poolDocumentId } = ctx.params;

    const stats = await strapi
      .plugin('unique-coupon')
      .service('unique-coupon')
      .getPoolStats(poolDocumentId);

    if (!stats) {
      return ctx.notFound('Pool not found');
    }

    return ctx.send(stats);
  },
});

export default uniqueCouponController;
