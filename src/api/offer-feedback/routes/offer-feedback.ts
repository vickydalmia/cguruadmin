export default {
  routes: [
    // Anonymous "worked / failed" offer feedback. Tight rate limit; NO cache
    // middleware — every vote must reach the controller.
    {
      method: 'POST',
      path: '/offer-feedback/:entityType/:documentId',
      handler: 'offer-feedback.submit',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 10, windowMs: 60_000 } },
        ],
      },
    },
  ],
};
