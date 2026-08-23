// Entity coupon-layout INVALIDATION: the ISR outbox event and cache purges
// a saved layout enqueues. Split out of the service coordinator (see
// ./entity-coupon-layout.ts).
import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';
import { insertIsrOutboxEvent } from '../../../isr-outbox/store';
import { SITEMAP_INDEX_PATH } from '../../../isr-outbox/payload';
import { wakeIsrOutbox } from '../../../isr-outbox/runtime';
import { purgeResponseCaches } from '../../../middlewares/cache';
import { toRouteSlug } from '../../../utils/route-normalization';
import {
  configFor,
  type EntityCouponLayoutKind,
} from './entity-coupon-layout-parse';

/**
 * Every surface a Coupon-layout change invalidates.
 *
 * `pagePaths` uses `toRouteSlug`, not a bare slash-trim. Stored slugs
 * legitimately carry an owned type namespace (`store/amazon`) while the
 * rendered page lives at `/amazon/`, so trimming alone emitted
 * `/store/amazon/` — a durable outbox event invalidating a path that does not
 * exist, leaving the real page stale. Every other producer of this path
 * normalizes the same way (curated-offer-relations `curatedSourcePath`,
 * isr-outbox/scopes).
 *
 * Coupon Top Picks and Ordered Coupons are not Product Deal curation. The
 * `-deals` page derives its Top Deals exclusively from live Deals, so a Coupon
 * layout save must never invalidate the Deal page or Deal response cache.
 */
export function couponLayoutInvalidation(
  config: { kind: EntityCouponLayoutKind; publicPath: string },
  rawSlug: unknown,
): { pagePaths: string[]; cachePaths: string[] } {
  const publicSlug = toRouteSlug(rawSlug, config.kind);
  // The response cache is keyed on Koa's ctx.path, which preserves the
  // percent-encoding of the incoming URL — and the frontend builds these
  // requests as `encodeURIComponent(sourceSlug)` (entity-offers-request.ts),
  // one path segment carrying the RAW stored slug. So the purge prefix must be
  // that same encoded form: for a stored slug `store/amazon` the cached key is
  // `/api/stores/store%2Famazon/coupons?...`, and a raw `store/amazon` prefix
  // matches nothing, silently leaving the stale ordering for the ISR
  // re-render to consume.
  const encodedSlug = encodeURIComponent(String(rawSlug ?? ''));
  return {
    // The sitemap index is listed alongside the pages, matching what
    // createOutboxPayload emits whenever a scope sets `sitemap` — the write
    // bumps `updated_at`, which is this entity's published lastmod.
    pagePaths: publicSlug
      ? [`/${publicSlug}/`, SITEMAP_INDEX_PATH]
      : [],
    cachePaths: [`/api/${config.publicPath}/${encodedSlug}/coupons`],
  };
}
