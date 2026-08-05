import type { Core } from '@strapi/strapi';

import {
  CHECKOUT_MERCHANT_FIELD,
  CHECKOUT_MERCHANT_SOURCES,
  formatCheckoutMerchant,
  parseCheckoutMerchant,
  type CheckoutMerchantKind,
} from '../constants/checkout-merchant';

/**
 * Resolves each offer's Checkout Merchant to that merchant's festive offer, and
 * attaches it to the public payload as `festiveOffer`.
 *
 * WHY THE SERVER DOES THIS. `checkoutMerchant` is stored as an opaque
 * `store:<documentId>` string (a custom field, not a relation — see
 * src/constants/checkout-merchant.ts), so it cannot be `populate`d. The
 * frontend therefore has no way to reach the merchant's festive fields on its
 * own: the merchant is frequently NOT among the offer's own stores/brands, and
 * even when it is, matching by documentId would mean teaching every one of the
 * frontend's ref types about three more fields. Resolving here instead means
 * the UI receives a finished `{ title, descriptionHtml }` and needs to know
 * nothing about merchants at all.
 *
 * WHY IT IS SEPARATE FROM arrayizeOfferText. That walker is synchronous and
 * pure — every transform it applies is a function of the node it is looking at.
 * This one needs a database read, so it cannot join that pass. It runs directly
 * after it, over the same payload, using the same "recurse into anything" shape
 * so the deeply-nested homepage and deal-of-the-day trees are handled by the
 * same code as a flat listing.
 *
 * COST. Two queries per response, no matter how many offers it contains — the
 * whole point of the field is that ONE merchant edit restyles thousands of
 * offers, so a per-offer lookup would be the wrong shape entirely. Offers are
 * collected in a single walk, their merchant ids de-duplicated, and one batched
 * query issued per kind.
 */

/** The finished block handed to the UI. Both halves are guaranteed non-blank. */
export type FestiveOfferPayload = {
  title: string;
  descriptionHtml: string;
};

type OfferNode = Record<string, unknown>;

const trimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
};

/**
 * Every node carrying a `checkoutMerchant` key is an offer payload — no other
 * public content type exposes it. Same discriminator style as the sibling
 * walker's `DEAL_PRICE_KEYS.some((key) => key in record)`.
 *
 * Recurses into offer nodes as well as past them: a coupon-page response nests
 * related coupons and deals beside the main offer, and the homepage nests
 * offers inside components inside sections.
 */
function collectOfferNodes(node: unknown, out: OfferNode[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOfferNodes(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const record = node as OfferNode;
  if (Object.prototype.hasOwnProperty.call(record, CHECKOUT_MERCHANT_FIELD)) {
    out.push(record);
  }
  for (const value of Object.values(record)) collectOfferNodes(value, out);
}

/**
 * One batched lookup per merchant kind. Returns a map keyed by the CANONICAL
 * `store:<id>` string, so pass two can look up a node's raw value after
 * normalising it through the same parse/format pair.
 *
 * Only merchants with a live festive offer are returned: the `isFestiveOffer`
 * filter is applied in the query, and rows whose title or description is blank
 * are dropped here. That is the single definition of "festive" — every caller
 * downstream just checks whether a value came back.
 */
async function loadFestiveMerchants(
  strapi: Core.Strapi,
  idsByKind: Record<CheckoutMerchantKind, Set<string>>,
): Promise<Map<string, FestiveOfferPayload>> {
  const found = new Map<string, FestiveOfferPayload>();

  for (const source of CHECKOUT_MERCHANT_SOURCES) {
    const documentIds = [...idsByKind[source.kind]];
    if (documentIds.length === 0) continue;

    const rows: any[] = await strapi.documents(source.target as any).findMany({
      filters: {
        documentId: { $in: documentIds },
        isFestiveOffer: true,
      },
      fields: [
        'documentId',
        'festiveOfferTitle',
        'festiveOfferDescription',
      ] as any,
      // Strapi defaults to 25 rows. A festive campaign spanning more than 25
      // merchants would silently lose the rest without this.
      limit: documentIds.length,
    });

    for (const row of rows) {
      const documentId = row?.documentId;
      if (typeof documentId !== 'string') continue;
      const title = trimmed(row.festiveOfferTitle);
      const descriptionHtml = trimmed(row.festiveOfferDescription);
      // The write pipeline requires both whenever the toggle is on, so this
      // only fires for rows written before that rule or through a path that
      // bypassed it. Half a festive offer renders worse than none.
      if (!title || !descriptionHtml) continue;

      found.set(formatCheckoutMerchant({ kind: source.kind, documentId }), {
        title,
        descriptionHtml,
      });
    }
  }

  return found;
}

/**
 * Attach `festiveOffer` to every offer in `payload`, and remove the raw
 * `checkoutMerchant` string on the way out (the UI has no use for an opaque
 * `store:<id>` — same tidy-up the sibling walker does for `discountPrefix`).
 *
 * Mutates in place. Never throws: a failed lookup logs and leaves the payload
 * with no festive offers, because a missing campaign is a far better outcome
 * than a 500 on the homepage.
 */
export async function attachFestiveOffers(
  strapi: Core.Strapi,
  payload: unknown,
): Promise<void> {
  const nodes: OfferNode[] = [];
  collectOfferNodes(payload, nodes);
  if (nodes.length === 0) return;

  const idsByKind: Record<CheckoutMerchantKind, Set<string>> = {
    store: new Set(),
    brand: new Set(),
  };
  for (const node of nodes) {
    const ref = parseCheckoutMerchant(node[CHECKOUT_MERCHANT_FIELD]);
    if (ref) idsByKind[ref.kind].add(ref.documentId);
  }

  let festiveByMerchant = new Map<string, FestiveOfferPayload>();
  try {
    festiveByMerchant = await loadFestiveMerchants(strapi, idsByKind);
  } catch (err: any) {
    strapi.log.warn(
      `[festive-offer] merchant lookup failed, offers render unstyled: ${
        err?.message ?? err
      }`,
    );
  }

  for (const node of nodes) {
    const ref = parseCheckoutMerchant(node[CHECKOUT_MERCHANT_FIELD]);
    delete node[CHECKOUT_MERCHANT_FIELD];
    if (!ref) continue;

    const festive = festiveByMerchant.get(formatCheckoutMerchant(ref));
    if (festive) node.festiveOffer = festive;
  }
}
