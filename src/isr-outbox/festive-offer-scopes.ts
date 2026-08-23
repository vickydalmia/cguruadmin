// FESTIVE-OFFER SCOPES: detecting festive-material changes on offers and
// Store/Brand rows and mapping them to the festive sale page. One of the
// modules split out of scopes.ts, which keeps the computeScope coordinator.
import type { Core } from '@strapi/strapi';
import type { ScopeRequest } from './types';
import {
  DEAL_OF_THE_DAY_SLUG,
  INDEPENDENCE_DAY_SALE_SLUG,
} from './scope-static-pages';
import { entityDealPageSlug } from '../api/entity-deal-page/services/entity-deal-route';
import {
  CHECKOUT_MERCHANT_FIELD,
  formatCheckoutMerchant,
} from '../constants/checkout-merchant';
import {
  ENTITY_TYPES,
  RELATION_KINDS,
  publicSlug,
} from './offer-relation-scopes';

/** Only Store and Brand carry these; category/bank writes never match. */
const FESTIVE_OFFER_KEYS = [
  'isFestiveOffer',
  'festiveOfferTitle',
  'festiveOfferDescription',
] as const;

/**
 * True when a Store/Brand update touches the festive offer keys at all. This
 * is only the cheap first gate — the decisions that matter are
 * `festiveOfferChanged` (did the rendered campaign actually change?) and
 * `festiveMerchantScope` (which pages does it repaint?).
 */
export function touchesFestiveOffer(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return FESTIVE_OFFER_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(data, key),
  );
}

/** Entity types carrying the festive fields — the only ones worth a pre-read. */
export const FESTIVE_OFFER_ENTITY_UIDS = new Set([
  'api::store.store',
  'api::brand.brand',
]);

/** The three festive fields as read from the row BEFORE the write. */
export type FestiveOfferSnapshot = {
  isFestiveOffer?: unknown;
  festiveOfferTitle?: unknown;
  festiveOfferDescription?: unknown;
};

const festiveTrimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
};

/**
 * What the row renders onto offer cards: the `title × description` pair when
 * the campaign is live AND complete, otherwise nothing. Mirrors
 * `loadFestiveMerchants` in utils/festive-offer-response.ts — the walker drops
 * rows with a blank half, so a write that only changes a blank half changes
 * nothing on any page.
 */
function festiveRendering(row: FestiveOfferSnapshot): string | null {
  if (row.isFestiveOffer !== true) return null;
  const title = festiveTrimmed(row.festiveOfferTitle);
  const description = festiveTrimmed(row.festiveOfferDescription);
  if (!title || !description) return null;
  return `${title}\u0000${description}`;
}

/**
 * True when the write actually CHANGES what festive rendering the merchant
 * contributes to offer cards. Key presence alone is NOT a change signal: the
 * content-manager edit form submits the full document, so every Store/Brand
 * save carries `isFestiveOffer` — treating that as festive activity would turn
 * a logo fix into a full-site rebuild. Escalation therefore requires the
 * effective before/after renderings to differ.
 *
 * `before` is captured by the documents middleware BEFORE the write (the same
 * pattern as `entityIdentityBefore` in
 * src/register/document-write-middleware.ts). When it could not be
 * read, fail toward invalidation: a spurious full rebuild costs minutes, a
 * missed one leaves a campaign stale everywhere.
 */
export function festiveOfferChanged(
  data: unknown,
  before: FestiveOfferSnapshot | null | undefined,
): boolean {
  if (!touchesFestiveOffer(data)) return false;
  if (!before || typeof before !== 'object') return true;

  const payload = data as Record<string, unknown>;
  const after: FestiveOfferSnapshot = { ...before };
  for (const key of FESTIVE_OFFER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      after[key] = payload[key];
    }
  }
  return festiveRendering(before) !== festiveRendering(after);
}

/**
 * Offers-per-merchant bound for the festive scan. Beyond it the slug list
 * would crowd `maxPaths` (ISR_REVALIDATE_MAX_PATHS, default 5000) — where the
 * payload layer degrades to a full invalidation anyway — so the scan stops
 * early and returns `full` without paying for the fan-out.
 */
const FESTIVE_OFFER_SCAN_LIMIT = 1_000;

const OFFER_UID_LIST = ['api::coupon.coupon', 'api::deal.deal'] as const;

/**
 * The exact page set a festive change repaints: every offer whose
 * `checkoutMerchant` names this Store/Brand — its detail page, the entity
 * pages listing it (both relation directions, mirroring offerRelationScope),
 * the deal landing page when Deals are involved, and the homepage. The
 * `checkoutMerchant` column is a plain indexed string, so membership is one
 * batched query per offer type plus one reverse lookup per entity type — six
 * queries total, and festive toggles are a handful of events per season.
 *
 * A merchant nobody checks out with returns an EMPTY scope: its campaign
 * renders on no card, so only the merchant's own narrow entity scope applies.
 * Failures are the caller's to catch; they must fail toward `full`.
 */
export async function festiveMerchantScope(
  strapi: Core.Strapi,
  uid: string,
  documentId: string,
): Promise<ScopeRequest> {
  const merchant = formatCheckoutMerchant({
    kind: uid === 'api::store.store' ? 'store' : 'brand',
    documentId,
  });

  const slugs = new Set<string>();
  const optionalSlugs = new Set<string>();
  const couponIds: string[] = [];
  const dealIds: string[] = [];

  for (const offerUid of OFFER_UID_LIST) {
    const offers: any[] = await strapi.documents(offerUid as any).findMany({
      filters: { [CHECKOUT_MERCHANT_FIELD]: merchant } as any,
      fields: ['documentId'] as any,
      populate: {
        stores: { fields: ['name', 'slug'] },
        brands: { fields: ['name', 'slug'] },
        categories: { fields: ['name', 'slug'] },
        banks: { fields: ['name', 'slug'] },
      } as any,
      limit: FESTIVE_OFFER_SCAN_LIMIT + 1,
    });
    if (offers.length > FESTIVE_OFFER_SCAN_LIMIT) {
      return { full: true, refreshScopes: ['routes'] };
    }

    const isDeal = offerUid === 'api::deal.deal';
    for (const offer of offers) {
      const numericId = Number(offer?.id);
      if (Number.isSafeInteger(numericId) && numericId > 0) {
        slugs.add(`${isDeal ? 'deal' : 'coupon'}/${numericId}`);
      }
      if (typeof offer?.documentId === 'string') {
        (isDeal ? dealIds : couponIds).push(offer.documentId);
      }
      for (const [field, kind] of RELATION_KINDS) {
        for (const related of offer?.[field] ?? []) {
          const slug = publicSlug(related?.slug, kind);
          if (slug) slugs.add(slug);
          const dealSlug = entityDealPageSlug(related?.name);
          if (isDeal && dealSlug) optionalSlugs.add(dealSlug);
        }
      }
    }
  }

  if (couponIds.length === 0 && dealIds.length === 0) return {};

  // Reverse direction, batched over all matched offers: curated
  // topPickCoupons/orderedCoupons and the entity-owned mapped relations, the
  // same both-directions stance offerRelationScope takes per offer.
  const entityPages = await Promise.all(
    ENTITY_TYPES.map(async ([entityUid, kind]) => {
      const membership: unknown[] = [];
      if (couponIds.length > 0) {
        membership.push(
          { coupons: { documentId: { $in: couponIds } } },
          { topPickCoupons: { documentId: { $in: couponIds } } },
          { orderedCoupons: { documentId: { $in: couponIds } } },
        );
      }
      if (dealIds.length > 0) {
        membership.push({ deals: { documentId: { $in: dealIds } } });
      }
      const entities: any[] = await strapi.documents(entityUid as any).findMany({
        filters: { $or: membership } as any,
        fields: ['name', 'slug'] as any,
        limit: FESTIVE_OFFER_SCAN_LIMIT,
      });
      return entities.map((entity) => ({
        slug: publicSlug(entity?.slug, kind),
        dealSlug: entityDealPageSlug(entity?.name),
      }));
    }),
  );
  for (const entity of entityPages.flat()) {
    if (entity.slug) slugs.add(entity.slug);
    if (dealIds.length > 0 && entity.dealSlug) {
      optionalSlugs.add(entity.dealSlug);
    }
  }
  if (dealIds.length > 0) slugs.add(DEAL_OF_THE_DAY_SLUG);
  if (couponIds.length > 0 || dealIds.length > 0) {
    slugs.add(INDEPENDENCE_DAY_SALE_SLUG);
  }

  return {
    slugs: [...slugs],
    ...(optionalSlugs.size > 0 ? { optionalSlugs: [...optionalSlugs] } : {}),
    // Festive offers render inside homepage sections; one extra page.
    homepage: true,
  };
}
