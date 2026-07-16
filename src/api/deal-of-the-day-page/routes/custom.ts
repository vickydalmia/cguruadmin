export default {
  routes: [
    {
      method: 'GET',
      path: '/deal-of-the-day-full',
      handler: 'custom.dealOfTheDayFull',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          // keyByPath: the handler ignores the query string, so cache-busting
          // query params must not mint fresh cache keys for this expensive
          // aggregate (each miss runs the full populate + backfill pipeline).
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
  ],
};
