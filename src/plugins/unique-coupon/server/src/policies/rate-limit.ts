import { errors } from '@strapi/utils';

import { isTrustedSocket } from '../../../../../middlewares/rate-limit';

/**
 * In-memory sliding-window rate limiter per IP — a BACKSTOP, not the primary
 * control.
 *
 * The ISR gateway already limits this route with a Redis-backed limiter
 * (10/IP/min, 300/min globally — see registerBrowserApi in
 * cguru-ui/isr-gateway/src/browser-api.ts), which is the one that is correct
 * across multiple nodes. This limit sits ABOVE the gateway's on purpose: set
 * lower, it becomes the binding control while being per-process, so N Strapi
 * instances would mean an effective N x limit and shared-NAT visitors would
 * collect 429s that the interstitial renders as "code currently unavailable".
 * Its job is only to stop a caller that reached Strapi without going through
 * the gateway.
 */
const requestCounts = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 30;     // comfortably above the gateway's 10/IP/min

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}

/**
 * Strapi policies are handlers, not Koa middleware factories. They receive
 * `(policyContext, routeConfig, { strapi })` and must return true/undefined to
 * allow the controller. Returning a middleware function is interpreted as a
 * failed policy and produces a 403 before redemption reaches the controller.
 */
export default (
  ctx: any,
  _config: unknown,
  { strapi: _strapi }: { strapi: any }
) => {
  // Same bypass as the global limiter (src/middlewares/rate-limit.ts), and
  // for the same reason: matched on the raw TCP socket, which cannot be
  // spoofed, unlike the koa-resolved IP. Without it a deployment that relies
  // on RATE_LIMIT_TRUSTED_IPS rather than TRUST_PROXY puts every visitor in
  // one bucket, and the whole site shares a single redemption allowance.
  if (isTrustedSocket(ctx.req?.socket?.remoteAddress)) {
    return true;
  }

  cleanup();

  // Use the koa-resolved client IP (honors TRUST_PROXY / X-Forwarded-For per
  // config/server.ts). Do NOT read raw X-Forwarded-For — it is
  // client-spoofable and lets an attacker rotate the header to bypass the
  // limit and drain a coupon pool.
  const ip: string = ctx.request.ip || 'unknown';

  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    ctx.set('Retry-After', String(retryAfterSec));
    throw new errors.RateLimitError('Rate limit exceeded. Try again later.');
  }

  entry.count++;
  return true;
};
