export default {
  routes: [
    {
      method: 'GET',
      path: '/partner-with-us-page-full',
      handler: 'custom.partnerWithUsPageFull',
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
