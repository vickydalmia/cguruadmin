import { factories } from '@strapi/strapi';

// The core `find` route is granted to the public role so the ISR frontend can
// read the active redirect table. It is therefore part of the public read
// surface (see docs/public-api.md) and must carry the same per-IP rate limit
// and TTL response cache as every other anonymous read route. Core routers take
// per-action `config` here, so the guards attach to `find` without disturbing
// the permission-gated findOne/create/update/delete actions.
//
// The cache is keyed by FULL URL (keyByPath is deliberately OFF): this endpoint
// is paginated (?pagination[page]=2), so the query string is semantically
// meaningful — exactly the case the cache middleware's own doc warns against
// keying by path alone. Keying by path would serve page 1's body for every
// page-2 request, capping the frontend at the first 100 redirects. (The
// filter/field cache-poisoning angle that full-URL keying also closed is now
// handled at the source: controllers/redirect.ts forces the query shape, so a
// caller can no longer vary anything but pagination.) The rate limit + the
// cache's MAX_ENTRIES cap bound the distinct-key growth that keyByPath was
// guarding against.
export default factories.createCoreRouter('api::redirect.redirect', {
  config: {
    find: {
      middlewares: [
        { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
        { name: 'global::cache', config: { ttlMs: 60_000 } },
      ],
    },
  },
});
