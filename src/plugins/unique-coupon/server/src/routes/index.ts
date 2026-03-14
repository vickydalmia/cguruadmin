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
      policies: ['admin::isAuthenticatedAdmin'],
    },
  },
  {
    method: 'GET',
    path: '/stats/:poolDocumentId',
    handler: 'unique-coupon.getStats',
    config: {
      policies: ['admin::isAuthenticatedAdmin'],
    },
  },
];
