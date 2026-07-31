import type { Core } from '@strapi/strapi';
import { hasAuthorizedIsrCacheBypass } from '../utils/isr-cache-bypass';

/**
 * In-process TTL response cache for expensive public GET aggregate endpoints
 * (/homepage-full, /site-chrome, /public-route-metadata). These change only
 * when content is republished (the cron rebuild hook fires on change), so a
 * short TTL is safe and blunts the DB cost of the deep populate + per-store
 * count queries under load or abuse.
 *
 * Per-instance only (not shared across horizontally-scaled nodes) — good
 * enough as a DoS dampener; a CDN in front should be the primary cache.
 *
 * Configure with: { ttlMs?: number, keyByPath?: boolean,
 * cacheKeyParams?: string[] }.
 *
 * Set `keyByPath` for endpoints that ignore the query string (e.g.
 * /directories/:kind): the cache key is then the path alone, so `?nonce=1`,
 * `?nonce=2`, … all share one entry instead of each forcing a fresh
 * full-catalog miss.
 *
 * Where SOME query parameters are meaningful, list exactly those in
 * `cacheKeyParams` (e.g. ['page','pageSize']). The key is then the path plus
 * those parameters in a fixed order, and every other parameter is ignored — so
 * `?page=2` still caches independently while `?page=2&nonce=N` cannot mint
 * unlimited distinct keys and evict real entries via MAX_ENTRIES.
 *
 * Leave both off only where the entire query string is meaningful.
 */
interface CacheEntry {
  expiresAt: number;
  body: unknown;
}

// Hard ceiling on live entries per store. Endpoints with user-controlled
// query strings (/search?query=...) produce unbounded distinct keys, so
// expired-only sweeping is not enough — a flood of unique queries inside one
// TTL window would otherwise grow the map without limit.
const MAX_ENTRIES = 500;

// All middleware instances register their stores here so content changes can
// purge cached responses immediately — otherwise an ISR revalidate could
// re-render pages from a response cached BEFORE the edit (up to ttlMs stale).
const allStores = new Set<Map<string, CacheEntry>>();

export function purgeResponseCaches(pathPrefixes?: readonly string[]): void {
  if (!pathPrefixes?.length) {
    for (const store of allStores) store.clear();
    return;
  }
  for (const store of allStores) {
    for (const key of store.keys()) {
      if (pathPrefixes.some((prefix) => key.startsWith(prefix))) {
        store.delete(key);
      }
    }
  }
}

export default (
  config: { ttlMs?: number; keyByPath?: boolean; cacheKeyParams?: string[] },
  { strapi: _strapi }: { strapi: Core.Strapi },
) => {
  const ttlMs = config?.ttlMs ?? 60_000;
  const keyByPath = config?.keyByPath ?? false;
  const cacheKeyParams = Array.isArray(config?.cacheKeyParams)
    ? [...config.cacheKeyParams].sort()
    : null;
  const store = new Map<string, CacheEntry>();
  allStores.add(store);

  const cacheKey = (ctx: any): string => {
    // Path-only key for query-agnostic endpoints, so arbitrary query strings
    // can't multiply distinct keys and bypass the cache (full-scan DoS).
    if (keyByPath) return ctx.path;
    if (!cacheKeyParams) return ctx.originalUrl;

    // Allow-listed parameters only, in a fixed order, so `?a=1&b=2` and
    // `?b=2&a=1` share an entry and unknown parameters cannot mint new ones.
    const parts = cacheKeyParams.map((name) => {
      const raw = ctx.query?.[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      return `${name}=${value === undefined ? '' : String(value)}`;
    });
    return `${ctx.path}?${parts.join('&')}`;
  };

  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.method !== 'GET') {
      return next();
    }

    // The admin and render Strapi containers have independent in-memory
    // stores. An editor save can purge only the admin process, so a durable
    // ISR render presents a signed credential and reads authoritative data
    // without poisoning or consuming the render process's normal cache.
    if (hasAuthorizedIsrCacheBypass(ctx)) {
      await next();
      ctx.set('X-Cache', 'BYPASS');
      return;
    }

    const key = cacheKey(ctx);
    const now = Date.now();
    const hit = store.get(key);
    if (hit && now < hit.expiresAt) {
      ctx.body = hit.body;
      ctx.set('X-Cache', 'HIT');
      return;
    }

    await next();

    // Only cache successful responses.
    if (ctx.status === 200 && ctx.body != null) {
      store.set(key, { expiresAt: now + ttlMs, body: ctx.body });
      ctx.set('X-Cache', 'MISS');
      if (store.size > MAX_ENTRIES) {
        // Drop expired entries first, then oldest-inserted live ones until
        // back under the cap (Map preserves insertion order).
        for (const [k, v] of store) {
          if (now >= v.expiresAt) store.delete(k);
        }
        for (const k of store.keys()) {
          if (store.size <= MAX_ENTRIES) break;
          store.delete(k);
        }
      }
    }
  };
};
