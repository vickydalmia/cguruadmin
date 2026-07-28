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
 *
 * RATE_LIMIT_TRUSTED_IPS (comma-separated exact IPs, or prefixes ending in
 * '.') bypasses the limiter entirely — set it to the Astro origin's VPC
 * private IP so ISR warm-up/revalidate bursts are never throttled. It is
 * matched against the raw TCP socket address, NOT ctx.request.ip: with
 * TRUST_PROXY=true the koa-resolved IP comes from X-Forwarded-For, which a
 * public client can spoof to impersonate the VPC — the socket address cannot.
 */
interface Window {
  count: number;
  resetAt: number;
}

const TRUSTED_IPS = (process.env.RATE_LIMIT_TRUSTED_IPS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

export function hasTrustedIpsConfigured(): boolean {
  return TRUSTED_IPS.length > 0;
}

function isTrustedSocket(remoteAddress: string | undefined): boolean {
  if (!remoteAddress || TRUSTED_IPS.length === 0) return false;
  const ip = remoteAddress.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
  return TRUSTED_IPS.some((trusted) =>
    trusted.endsWith('.') ? ip.startsWith(trusted) : ip === trusted,
  );
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
    if (isTrustedSocket(ctx.req?.socket?.remoteAddress)) {
      return next();
    }

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
