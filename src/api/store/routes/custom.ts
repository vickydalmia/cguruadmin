export default {
  routes: [
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
