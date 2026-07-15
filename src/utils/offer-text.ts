// `offerText` is stored as a short text string ("EXTRA 18% OFF") for easy admin
// editing, but the offer cards render it as separate words — a small qualifier,
// a big value, and "OFF". So the public API splits it into an array of words on
// the way out. Only `offerText` is transformed; `cashbackText`/`bankOfferText`
// stay plain strings.

/** Split a stored offerText string ("EXTRA 18% OFF") into its render words. */
export function splitOfferWords(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * Recursively replace every string `offerText` field in an API response with an
 * array of its words, so a coupon/deal card can render each word in its own
 * slot. Handles both flat listings and the deeply-nested homepage payload
 * (coupons/deals live inside components inside sections). Mutates in place and
 * returns the same reference; non-string `offerText` (null/absent) is untouched.
 */
export function arrayizeOfferText<T>(node: T): T {
  if (Array.isArray(node)) {
    for (const item of node) arrayizeOfferText(item);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'offerText' && typeof value === 'string') {
        (node as Record<string, unknown>)[key] = splitOfferWords(value);
      } else {
        arrayizeOfferText(value);
      }
    }
  }
  return node;
}
