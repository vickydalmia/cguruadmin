import type { Core } from '@strapi/strapi';

type OfferEntityType = 'coupon' | 'deal';

const OFFER_UIDS: Record<string, OfferEntityType> = {
  'api::coupon.coupon': 'coupon',
  'api::deal.deal': 'deal',
};

export function offerEntityTypeFromUid(uid: string): OfferEntityType | null {
  return OFFER_UIDS[uid] ?? null;
}

// Delete-only invalidation for the lazy frontend redeem cache. This function
// never resolves or warms an offer: the next real visitor request repopulates
// that one exact Coupon/Deal key in the gateway.
export async function invalidateOfferRedeemCache(
  strapi: Core.Strapi,
  uid: string,
  documentId: string | null | undefined,
): Promise<void> {
  const entityType = offerEntityTypeFromUid(uid);
  const gatewayUrl = process.env.ISR_GATEWAY_URL?.trim().replace(/\/+$/, '');
  const secret = process.env.ISR_REVALIDATE_SECRET?.trim();
  if (!entityType || !documentId || !gatewayUrl || !secret) return;

  const timeoutMs = Math.max(
    500,
    Number(process.env.REDEEM_INVALIDATE_TIMEOUT_MS) || 5_000,
  );
  const response = await fetch(`${gatewayUrl}/revalidate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      offerInvalidations: [{ entityType, documentId }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`gateway returned ${response.status}`);
  }

  strapi.log.info(`[offer-redeem] invalidated ${entityType}:${documentId}`);
}
