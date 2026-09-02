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
 *
 * RATE_LIMIT_TRUST_PRIVATE_SOCKETS=true additionally trusts every private
 * (RFC1918/loopback/ULA) socket address, with no per-host IP to configure.
 * Only the render-plane container may set it: its port is published on
 * loopback and the VPC private IP and firewalled, so every socket that can
 * reach it is internal by construction — on a single-server deployment the
 * source is a Docker bridge address that shifts between hosts and would
 * otherwise need hand-maintained allowlisting. The admin container must NEVER
 * set it: nginx- and gateway-proxied visitor traffic reaches that container
 * from the same private bridge gateway, and trusting it would switch the
 * public rate limiter off.
 */
interface Window {
  count: number;
  resetAt: number;
}

const TRUSTED_IPS = (process.env.RATE_LIMIT_TRUSTED_IPS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const TRUST_PRIVATE_SOCKETS =
  process.env.RATE_LIMIT_TRUST_PRIVATE_SOCKETS === 'true';

export function hasTrustedIpsConfigured(): boolean {
  return TRUSTED_IPS.length > 0 || TRUST_PRIVATE_SOCKETS;
}

function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const octets = ip.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * Exported so the unique-coupon redeem policy shares this exact bypass rather
 * than reimplementing it — that policy previously had none, so a deployment
 * relying on RATE_LIMIT_TRUSTED_IPS put every visitor in one redemption bucket.
 */
export function isTrustedSocket(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const ip = remoteAddress.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
  if (TRUST_PRIVATE_SOCKETS && isPrivateAddress(ip)) return true;
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
