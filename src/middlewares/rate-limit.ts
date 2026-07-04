import type { Core } from '@strapi/strapi';

/**
 * In-process sliding-window rate limiter for public endpoints. Keys on the
 * koa-resolved client IP (`ctx.request.ip`), which already honors the
 * TRUST_PROXY / X-Forwarded-For chain configured in config/server.ts — we do
 * NOT read raw X-Forwarded-For here, since that header is client-spoofable.
 *
 * Per-instance only; behind multiple nodes each holds its own window. Use a
 * shared store (Redis) if strict global limits are required. Configure with:
 * { maxRequests?: number, windowMs?: number }.
 */
interface Window {
  count: number;
  resetAt: number;
}

export default (
  config: { maxRequests?: number; windowMs?: number },
  { strapi: _strapi }: { strapi: Core.Strapi },
) => {
  const maxRequests = config?.maxRequests ?? 60;
  const windowMs = config?.windowMs ?? 60_000;
  const counts = new Map<string, Window>();
  let lastCleanup = Date.now();

  return async (ctx: any, next: () => Promise<void>) => {
    const now = Date.now();

    // Periodic sweep of expired windows to bound memory.
    if (now - lastCleanup > 5 * 60_000) {
      lastCleanup = now;
      for (const [ip, w] of counts) {
        if (now > w.resetAt) counts.delete(ip);
      }
    }

    const ip: string = ctx.request.ip || 'unknown';
    const entry = counts.get(ip);

    if (!entry || now > entry.resetAt) {
      counts.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      ctx.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return ctx.tooManyRequests('Rate limit exceeded. Try again later.');
    }

    entry.count++;
    return next();
  };
};
