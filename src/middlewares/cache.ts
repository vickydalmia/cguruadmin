import type { Core } from '@strapi/strapi';

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
 * Configure with: { ttlMs?: number, keyByPath?: boolean }. Set `keyByPath` for
 * endpoints that ignore the query string (e.g. /directories/:kind): the cache
 * key is then the path alone, so `?nonce=1`, `?nonce=2`, … all share one entry
 * instead of each forcing a fresh full-catalog miss. Leave it off where the
 * query is semantically meaningful (e.g. /offers?page=2).
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

export function purgeResponseCaches(): void {
  for (const store of allStores) store.clear();
}

export default (
  config: { ttlMs?: number; keyByPath?: boolean },
  { strapi: _strapi }: { strapi: Core.Strapi },
) => {
  const ttlMs = config?.ttlMs ?? 60_000;
  const keyByPath = config?.keyByPath ?? false;
  const store = new Map<string, CacheEntry>();
  allStores.add(store);

  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.method !== 'GET') {
      return next();
    }

    // Path-only key for query-agnostic endpoints, so arbitrary query strings
    // can't multiply distinct keys and bypass the cache (full-scan DoS).
    const key = keyByPath ? ctx.path : ctx.originalUrl;
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
