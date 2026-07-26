export default {
  routes: [
    {
      // lastmod + image decoration for the sharded sitemap. Deployment-facing
      // like /isr-offer-routes, but public so the SSR renderer can read it
      // without the ISR admin secret. `keyByPath` because the endpoint takes
      // no query parameters — a `?nonce=` flood must not force full-catalog
      // misses.
      method: 'GET',
      path: '/sitemap-entities',
      handler: 'sitemap.getSitemapEntities',
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
