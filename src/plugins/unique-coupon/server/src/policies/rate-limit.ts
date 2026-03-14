/**
 * In-memory sliding-window rate limiter per IP.
 * Limits each IP to `maxRequests` within `windowMs`.
 */
const requestCounts = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 5;      // 5 redemptions per minute per IP

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

export default (_config: unknown, { strapi: _strapi }: { strapi: any }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    cleanup();

    const ip: string =
      ctx.request.ip ||
      ctx.request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      'unknown';

    const now = Date.now();
    const entry = requestCounts.get(ip);

    if (!entry || now > entry.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return next();
    }

    if (entry.count >= MAX_REQUESTS) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      ctx.set('Retry-After', String(retryAfterSec));
      return ctx.tooManyRequests('Rate limit exceeded. Try again later.');
    }

    entry.count++;
    return next();
  };
};
