const ENTITY_ROUTES = [
  ['stores', 'store'],
  ['brands', 'brand'],
  ['categories', 'category'],
  ['banks', 'bank'],
] as const;

export default {
  routes: [
    {
      method: 'GET',
      path: '/entity-popular-searches/:kind/:slug',
      handler: 'custom.entityPopularSearches',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::cache',
            config: { ttlMs: 60_000, keyByPath: true },
          },
        ],
      },
    },
    ...ENTITY_ROUTES.map(([plural]) => ({
      method: 'GET',
      path: `/${plural}/:slug/related-stores`,
      handler: 'custom.relatedStores',
      config: {
        auth: false,
        middlewares: [
          'global::set-entity-type',
          { name: 'global::cache', config: { ttlMs: 60_000 } },
        ],
      },
    })),
    // Anonymous star-rating submission. Tight rate limit; NO cache middleware —
    // every vote must reach the controller.
    {
      method: 'POST',
      path: '/stores/:slug/rating',
      handler: 'custom.submitRating',
      config: {
        auth: false,
        middlewares: [
          'global::set-entity-type',
          { name: 'global::rate-limit', config: { maxRequests: 5, windowMs: 60_000 } },
        ],
      },
    },
    ...ENTITY_ROUTES.filter(([plural]) => plural !== 'stores').map(([plural]) => ({
      method: 'POST',
      path: `/${plural}/:slug/rating`,
      handler: 'custom.submitRating',
      config: {
        auth: false,
        middlewares: [
          'global::set-entity-type',
          { name: 'global::rate-limit', config: { maxRequests: 5, windowMs: 60_000 } },
        ],
      },
    })),
  ],
};
