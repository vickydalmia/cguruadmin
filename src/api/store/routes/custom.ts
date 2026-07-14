export default {
  routes: [
    // Store-sidebar recommendations. Server-rendered store pages call this
    // with the categories already found on that store's coupons/deals, so we
    // can return a small related-store list without touching /homepage-full.
    {
      method: 'GET',
      path: '/stores/:slug/related-stores',
      handler: 'custom.relatedStores',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::cache', config: { ttlMs: 60_000 } },
        ],
      },
    },
    // Anonymous star-rating submission. Tight rate limit; NO cache middleware —
    // every vote must reach the controller.
    {
      method: 'POST',
      path: '/stores/:slug/rating',
      handler: 'custom.submitRating',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 5, windowMs: 60_000 } },
        ],
      },
    },
  ],
};
