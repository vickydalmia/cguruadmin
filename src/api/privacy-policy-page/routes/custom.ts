export default {
  routes: [
    {
      method: 'GET',
      path: '/privacy-policy-page-full',
      handler: 'custom.privacyPolicyPageFull',
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
