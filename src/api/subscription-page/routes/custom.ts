export default {
  routes: [{
    method: 'GET', path: '/subscription-page-full', handler: 'custom.subscriptionPageFull',
    config: {
      auth: false,
      middlewares: [
        { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
        { name: 'global::cache', config: { ttlMs: 60_000, cacheKeyParams: ['locale'] } },
      ],
    },
  }],
};
