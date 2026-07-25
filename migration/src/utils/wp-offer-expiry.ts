export type WpOfferExpiryMeta = Record<string, string>;

/**
 * Resolve the active WordPress expiry value using the same plugin precedence
 * for Coupons, Product Deals, lifecycle inclusion, and verification.
 */
export function getWpOfferExpiryRaw(
  meta: WpOfferExpiryMeta,
): string | undefined {
  if (meta["_action_manager_date"]) {
    return meta["_action_manager_date"];
  }

  if (
    meta["_expiration-date-status"] &&
    meta["_expiration-date-status"] !== "saved"
  ) {
    return undefined;
  }

  return meta["_expiration-date"] || meta["expiration-date"];
}
