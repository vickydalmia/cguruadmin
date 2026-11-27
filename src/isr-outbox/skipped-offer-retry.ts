import type { IsrOutboxPayload } from './types';

const SKIPPED_ERROR = /^gateway skipped [1-9]\d* path\(s\): (\S.*)$/;
const OFFER_DETAIL_PATH = /^\/(?:coupon|deal)\/[1-9]\d*\/$/;

/**
 * Re-declare skipped Coupon/Deal detail paths as optional before a retry.
 *
 * A detail page is a route only while its offer is public. Commands built
 * before this rule (and any producer that still lists an expired, scheduled,
 * or deleted offer's own page as required) are skipped by the gateway forever,
 * and every retry re-runs the whole fan-out: every other page in the command,
 * a full route-inventory install, and a sitemap expansion.
 *
 * The gateway still accepts an optional path's absence only after a
 * successful inventory refresh proved the route is not admitted, and it
 * renders the path normally when it is live, so nothing that exists is
 * dropped. Only offer detail paths that the command itself listed are
 * touched; any other skipped route stays required and is bounded by the
 * skipped-only retry limit in `store.ts`.
 *
 * `last_error` is capped at 4,000 characters. A truncated final entry never
 * matches the detail-path shape, and the paths it hides are repaired after
 * the next attempt reports them again.
 */
export function reconcileSkippedOfferRetry(
  payload: IsrOutboxPayload,
  lastError: string | null,
): IsrOutboxPayload {
  const listed = lastError?.match(SKIPPED_ERROR)?.[1];
  if (!listed || !payload.paths?.length) return payload;
  const paths = new Set(payload.paths);
  const optional = new Set(payload.optionalPaths ?? []);
  const repaired = [
    ...new Set(
      listed
        .split(', ')
        .filter(
          (path) =>
            OFFER_DETAIL_PATH.test(path) && paths.has(path) && !optional.has(path),
        ),
    ),
  ];
  if (repaired.length === 0) return payload;
  return {
    ...payload,
    optionalPaths: [...(payload.optionalPaths ?? []), ...repaired],
  };
}
