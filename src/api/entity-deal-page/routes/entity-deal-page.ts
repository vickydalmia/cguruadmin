const superAdminPolicies = [
  'admin::isAuthenticatedAdmin',
  'global::super-admin-only',
] as const;

export default {
  routes: [
    {
      method: 'GET',
      path: '/entity-deal-pages/:dealSlug',
      handler: 'api::entity-deal-page.entity-deal-page.publicFind',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::rate-limit',
            config: { maxRequests: 60, windowMs: 60_000 },
          },
          { name: 'global::cache', config: { ttlMs: 60_000 } },
        ],
      },
    },
    {
      method: 'GET',
      path: '/entity-deal-page-routes',
      handler: 'api::entity-deal-page.entity-deal-page.publicRoutes',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::rate-limit',
            config: { maxRequests: 60, windowMs: 60_000 },
          },
          {
            name: 'global::cache',
            config: { ttlMs: 60_000, keyByPath: true },
          },
        ],
      },
    },
    {
      method: 'GET',
      path: '/admin/entity-deal-pages',
      handler: 'api::entity-deal-page.entity-deal-page.adminList',
      config: { policies: superAdminPolicies },
    },
    {
      method: 'PATCH',
      path: '/admin/entity-deal-pages/:kind/:documentId',
      handler: 'api::entity-deal-page.entity-deal-page.adminUpdate',
      config: { policies: superAdminPolicies },
    },
  ],
};
