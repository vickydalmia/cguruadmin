// Only the two anonymous read routes live here. The Super-Admin settings
// endpoints are registered as ADMIN-type routes in src/index.ts: everything
// under src/api/*/routes is forced to `type: 'content-api'` by Strapi's
// registerAPIRoutes, and the content API only serves the api-token and
// users-permissions strategies — an admin-panel session can never authenticate
// against it. See src/policies/super-admin-only.ts.
export default {
  routes: [
    {
      method: 'GET',
      path: '/entity-deal-pages/:dealSlug',
      handler: 'api::entity-deal-page.entity-deal-page.publicFind',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::rate-limit',
            config: { maxRequests: 60, windowMs: 60_000 },
          },
          // `page`/`pageSize` are the only meaningful parameters. Ignore
          // unrelated query noise so `?nonce=N` cannot churn the cache.
          {
            name: 'global::cache',
            config: { ttlMs: 60_000, cacheKeyParams: ['page', 'pageSize'] },
          },
        ],
      },
    },
    {
      method: 'GET',
      path: '/entity-deal-page-routes',
      handler: 'api::entity-deal-page.entity-deal-page.publicRoutes',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::rate-limit',
            config: { maxRequests: 60, windowMs: 60_000 },
          },
          {
            name: 'global::cache',
            config: { ttlMs: 60_000, keyByPath: true },
          },
        ],
      },
    },
  ],
};
