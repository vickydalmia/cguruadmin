export default {
  routes: [
    {
      method: 'GET',
      path: '/search',
      handler: 'search.search',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 120, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 30_000 } },
        ],
      },
    },
  ],
};
