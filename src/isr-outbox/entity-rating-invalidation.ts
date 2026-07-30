import type { Core } from '@strapi/strapi';
import { logIsrOutbox } from './log';
import { createOutboxPayload } from './payload';
import { enqueueStandaloneIsrEvent } from './runtime';
import { toRouteSlug, type IdentityKind } from '../utils/route-normalization';

/**
 * Anonymous star votes are written with the Query Engine (knex) straight onto
 * the entity row, so they never reach the document middleware that enqueues
 * every other invalidation. Without this the rendered hero average, the review
 * count and the aggregateRating JSON-LD stay frozen at whatever the last
 * editorial save produced — a visitor who rates an unrated entity reloads into
 * empty stars.
 *
 * A vote changes exactly one rendered page, so the event carries that single
 * path. Accepting it only bumps the gateway's path version; the page is
 * re-rendered lazily on its next request, which is why one event per vote is
 * affordable.
 *
 * Best effort by construction: the vote is already committed, and a failed
 * enqueue must not turn a saved rating into a 500 for the visitor.
 */
export async function enqueueEntityRatingInvalidation(
  strapi: Core.Strapi,
  entityType: IdentityKind,
  storedSlug: string,
): Promise<void> {
  // The vote is addressed by the stored slug; the page is addressed by the
  // public route. They differ whenever a slug carries its own type namespace.
  const routeSlug = toRouteSlug(storedSlug, entityType);
  if (!routeSlug) return;

  try {
    await enqueueStandaloneIsrEvent(strapi, {
      payload: createOutboxPayload({ slugs: [routeSlug] }),
      reason: `rating:${entityType}:${routeSlug}`,
    });
  } catch (err: any) {
    logIsrOutbox(strapi, 'error', 'isr.outbox.rating_enqueue_failed', {
      entityType,
      slug: routeSlug,
      error: err?.message ?? String(err),
    });
  }
}
