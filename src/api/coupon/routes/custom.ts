export default {
  routes: [
    // Private gateway-only resolver. Core Coupon/Deal findOne routes stay
    // disabled so unique-code pools cannot be populated by public callers.
    {
      method: 'GET',
      path: '/offer-redeem/:entityType/:documentId',
      handler: 'custom.getRedeemOffer',
      config: { auth: false },
    },
    // Global listings of ALL published offers/deals (core find is disabled).
    {
      method: 'GET',
      path: '/offers',
      handler: 'custom.getAllOffers',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 60_000 } },
        ],
      },
    },
    {
      method: 'GET',
      path: '/deals',
      handler: 'custom.getAllDeals',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 60, windowMs: 60_000 } },
          { name: 'global::cache', config: { ttlMs: 60_000 } },
        ],
      },
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
