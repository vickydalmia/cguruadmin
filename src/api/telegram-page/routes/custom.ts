export default {
  routes: [
    {
      method: 'GET',
      path: '/telegram-page-full',
      handler: 'custom.telegramPageFull',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          // keyByPath: the handler ignores the query string (the cache
          // middleware folds ?locale= into the key itself), so cache-busting
          // params must not mint fresh keys for this aggregate.
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
  ],
};
