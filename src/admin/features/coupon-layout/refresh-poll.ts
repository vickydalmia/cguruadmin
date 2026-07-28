/**
 * Polling policy for the post-save ISR refresh status.
 *
 * Kept out of the hook so it can be tested without pulling in
 * `@strapi/strapi/admin`, the same reason order-preview-response.ts exists.
 */

/**
 * States the poller stops on.
 *
 * `accepted` is deliberately NOT one of them. The controller sets it from
 * `row.status === 'delivered'` — the outbox event reached the gateway — and
 * the render-status probe only ever upgrades it to `rendered` or `failed`. So
 * `accepted` is the ordinary intermediate state for "delivered, render still
 * in flight", not a resting place. Treating it as terminal stopped polling at
 * the exact moment delivery succeeded, pinning the panel at
 * "Saved—refresh queued" forever and losing both the success and the failure
 * that follow.
 *
 * Polling is bounded by the attempt cap and backoff below, not by this set.
 */
export const TERMINAL_REFRESH_STATES = new Set(['rendered', 'failed']);

export const REFRESH_POLL_BASE_MS = 2_000;
export const REFRESH_POLL_MAX_MS = 15_000;
export const REFRESH_POLL_MAX_ATTEMPTS = 20;

export function isTerminalRefreshState(state: unknown): boolean {
  return TERMINAL_REFRESH_STATES.has(String(state));
}

/**
 * Linear backoff, capped. A queue that is slow now is unlikely to be fast a
 * second later, and this runs while an editor sits on the page.
 */
export function refreshPollDelayMs(attempt: number): number {
  return Math.min(REFRESH_POLL_BASE_MS * attempt, REFRESH_POLL_MAX_MS);
}
