export default {
  routes: [
    {
      method: 'GET',
      path: '/ui-dictionary',
      handler: 'ui-dictionary.find',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          // keyByPath: the cache folds `locale` into the key only for enabled
          // codes, and the controller normalises everything else to `en`, so
          // `?locale=zz` cannot mint its own entry.
          { name: 'global::cache', config: { ttlMs: 60_000, keyByPath: true } },
        ],
      },
    },
    {
      // `auth` left undefined on purpose: Strapi's content-api token auth
      // applies, with the auto-derived scope
      // `api::ui-dictionary.ui-dictionary.syncCatalogue` a Custom API token
      // must be granted (a Read-only token gets 403).
      method: 'POST',
      path: '/ui-dictionary/catalogue',
      handler: 'ui-dictionary.syncCatalogue',
      config: {
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 12, windowMs: 60_000 } },
        ],
      },
    },
  ],
};
