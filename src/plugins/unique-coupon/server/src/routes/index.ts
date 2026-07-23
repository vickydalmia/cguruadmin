export default [
  {
    method: 'POST',
    path: '/redeem',
    handler: 'unique-coupon.redeem',
    config: {
      policies: ['plugin::unique-coupon.rate-limit'],
      auth: false,
    },
  },
  {
    method: 'POST',
    path: '/upload',
    handler: 'unique-coupon.uploadCodes',
    config: {
      policies: [
        'admin::isAuthenticatedAdmin',
        // Authentication alone is not enough: any admin role (even read-only)
        // could import codes. Require the dedicated action, granted per role
        // under Settings > Roles > Plugins (registered in ../index.ts).
        {
          name: 'admin::hasPermissions',
          config: { actions: ['plugin::unique-coupon.codes.import'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/stats/:poolDocumentId',
    handler: 'unique-coupon.getStats',
    config: {
      policies: [
        'admin::isAuthenticatedAdmin',
        {
          name: 'admin::hasPermissions',
          config: { actions: ['plugin::unique-coupon.codes.import'] },
        },
      ],
    },
  },
];
