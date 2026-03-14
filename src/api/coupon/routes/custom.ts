export default {
  routes: [
    {
      method: 'GET',
      path: '/search',
      handler: 'custom.search',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/deals/tag/:tagSlug',
      handler: 'custom.getDealsByTag',
      config: { auth: false },
    },
    // Store coupons/deals
    {
      method: 'GET',
      path: '/stores/:slug/coupons',
      handler: 'custom.getCouponsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    {
      method: 'GET',
      path: '/stores/:slug/deals',
      handler: 'custom.getDealsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    // Bank coupons/deals
    {
      method: 'GET',
      path: '/banks/:slug/coupons',
      handler: 'custom.getCouponsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    {
      method: 'GET',
      path: '/banks/:slug/deals',
      handler: 'custom.getDealsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    // Category coupons/deals
    {
      method: 'GET',
      path: '/categories/:slug/coupons',
      handler: 'custom.getCouponsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    {
      method: 'GET',
      path: '/categories/:slug/deals',
      handler: 'custom.getDealsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    // Brand coupons/deals
    {
      method: 'GET',
      path: '/brands/:slug/coupons',
      handler: 'custom.getCouponsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
    {
      method: 'GET',
      path: '/brands/:slug/deals',
      handler: 'custom.getDealsByEntity',
      config: { auth: false, middlewares: ['global::set-entity-type'] },
    },
  ],
};
