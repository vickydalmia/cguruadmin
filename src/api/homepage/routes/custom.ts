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
          { name: 'global::cache', config: { ttlMs: 60_000 } },
        ],
      },
    },
    {
      method: 'GET',
      path: '/site-chrome',
      handler: 'custom.siteChrome',
      config: {
        auth: false,
        middlewares: [{ name: 'global::cache', config: { ttlMs: 300_000 } }],
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
