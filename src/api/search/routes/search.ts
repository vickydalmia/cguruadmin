export default {
  routes: [
    {
      method: 'GET',
      path: '/search/status',
      handler: 'search.status',
      // Machine-only diagnostics use the same deploy secret as ISR
      // revalidation. The global policy fails closed and compares the exact
      // Bearer value in constant time; the route remains uncached.
      config: {
        auth: false,
        policies: ['global::search-status-auth'],
      },
    },
    {
      method: 'GET',
      path: '/search',
      handler: 'search.search',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 120, windowMs: 60_000 } },
          // Safe above the old 30s: every content write (and the 5-minute
          // offer-expiry cron's writes) purges this cache via
          // purgeResponseCaches, so the TTL only bounds purge-less drift.
          { name: 'global::cache', config: { ttlMs: 120_000 } },
        ],
      },
    },
  ],
};
