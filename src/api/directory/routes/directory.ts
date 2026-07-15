export default {
  routes: [
    {
      method: 'GET',
      path: '/directories/:kind',
      handler: 'api::directory.directory.find',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 120, windowMs: 60_000 } },
          // Directory ignores the query string — key the cache by path only so
          // `?nonce=…` variants can't bypass it and force full-catalog scans.
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
  ],
};
