export default {
  routes: [
    {
      method: 'GET',
      path: '/about-page-full',
      handler: 'custom.aboutPageFull',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          // keyByPath: the handler ignores the query string, so cache-busting
          // query params must not mint fresh cache keys for this aggregate.
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
  ],
};
