export default {
  routes: [
    {
      method: 'GET',
      path: '/error-page-full',
      handler: 'custom.errorPageFull',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 300_000 } },
        ],
      },
    },
  ],
};
