export default {
  routes: [
    {
      method: 'GET',
      path: '/homepage-full',
      handler: 'custom.homepageFull',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          // keyByPath: the handler ignores the query string entirely, so
          // keying the cache on the full URL let ?nonce=N bypass it and
          // re-run the expensive homepage aggregation per unique query.
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
    {
      method: 'GET',
      path: '/site-chrome',
      handler: 'custom.siteChrome',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::cache', config: { ttlMs: 300_000, keyByPath: true } },
        ],
      },
    },
    {
      method: 'GET',
      path: '/header-notification',
      handler: 'custom.headerNotification',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
    {
      method: 'GET',
      path: '/public-route-metadata',
      handler: 'custom.publicRouteMetadata',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
  ],
};
