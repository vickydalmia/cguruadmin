/**
 * Amazon Creator Connections disclosure for Product Deals.
 *
 * Editors opt in with a Deal-only boolean. The sentence is derived on public
 * responses instead of being written into `content`, so switching the flag
 * off removes it cleanly and repeated response decoration cannot duplicate it.
 */

export const AMAZON_AFFILIATE_DISCLOSURE_FIELD =
  'enableAmazonAffiliateDisclosure';

export const AMAZON_AFFILIATE_DISCLOSURE_TEXT =
  "Disclosure - This is a Sponsored Content under Amazon India's Creator Connections Program";

export const AMAZON_AFFILIATE_DISCLOSURE_HTML =
  `<p data-offer-final-condition="amazon-affiliate-disclosure">${AMAZON_AFFILIATE_DISCLOSURE_TEXT}</p>`;

const AMAZON_IDENTITY_KEYS = new Set([
  'amazon',
  'amazonindia',
  'amazoncoupons',
  'amazonindiacoupons',
]);

function identityKey(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, '')
    : '';
}

function isAmazonRelation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const relation = value as Record<string, unknown>;
  return (
    AMAZON_IDENTITY_KEYS.has(identityKey(relation.name)) ||
    AMAZON_IDENTITY_KEYS.has(identityKey(relation.slug))
  );
}

function relationIncludesAmazon(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some(isAmazonRelation)
    : isAmazonRelation(value);
}

/** True when Amazon is selected as one of the Deal's merchant taxonomies. */
export function isAmazonDeal(deal: Record<string, unknown>): boolean {
  return (
    relationIncludesAmazon(deal.stores) ||
    relationIncludesAmazon(deal.brands)
  );
}

/**
 * Return the public "Any Other Condition" HTML. Authored content is preserved
 * byte-for-byte and the derived disclosure is always the final paragraph.
 */
export function withAmazonAffiliateDisclosure(
  deal: Record<string, unknown>,
): unknown {
  const content = deal.content;
  if (
    deal[AMAZON_AFFILIATE_DISCLOSURE_FIELD] !== true ||
    !isAmazonDeal(deal)
  ) {
    return content;
  }

  const authored = typeof content === 'string' ? content : '';
  if (authored.endsWith(AMAZON_AFFILIATE_DISCLOSURE_HTML)) return authored;
  return `${authored}${AMAZON_AFFILIATE_DISCLOSURE_HTML}`;
}
