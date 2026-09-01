// Pre-calculated "Deal Details" template for Product Deals, sent to the UI as
// `computedContent` alongside the editor-written `content`:
//
//   Deal Price - ₹1,299    ← bold/highlighted
//   MRP - ₹2,999           ← as is
//   Discount - 56% OFF     ← as is (the stored `discount` string, verbatim)
//
// Lines with no data are skipped. The written `content` (optional since this
// template exists) becomes the extra "Any Other Condition" section — the UI
// composes the two, so both are sent separately. Attached to every public deal
// payload by the response walker in offer-text.ts; never stored, and the admin
// never sees it. Currency symbol, number grouping and the MRP wording follow
// the site-configuration localization so every country domain reads correctly.

import {
  currentOfferContentLocalization,
  type OfferContentLocalization,
} from './offer-content-localization';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "1299.00" / 1299 → "₹1,299" (per site localization); null for absent/zero/malformed amounts. */
function formatAmount(
  value: unknown,
  localization: OfferContentLocalization,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return `${localization.currencySymbol}${new Intl.NumberFormat(
    localization.locale,
    { maximumFractionDigits: 2 },
  ).format(amount)}`;
}

export function buildDealComputedContent(deal: {
  salePrice?: unknown;
  mrp?: unknown;
  discount?: unknown;
}): string | null {
  const localization = currentOfferContentLocalization();
  const price = formatAmount(deal.salePrice, localization);
  const mrp = formatAmount(deal.mrp, localization);
  // "MRP" is India's statutory retail term; other countries say "List Price".
  const mrpLabel = localization.countryCode === 'IN' ? 'MRP' : 'List Price';
  const discount =
    typeof deal.discount === 'string' && deal.discount.trim()
      ? deal.discount.trim()
      : null;

  const lines = [
    price ? `<p><strong>Deal Price - ${price}</strong></p>` : null,
    mrp ? `<p>${mrpLabel} - ${mrp}</p>` : null,
    discount ? `<p>Discount - ${escapeHtml(discount)}</p>` : null,
  ].filter(Boolean);

  return lines.length ? lines.join('') : null;
}
