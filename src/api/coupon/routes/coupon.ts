import { factories } from '@strapi/strapi';

// Core routes are disabled: the public frontend consumes coupons only through
// the hardened custom controllers (homepage-full, entity offers, search), which
// fully control `populate`. Leaving core find/findOne open would let a caller
// populate uniqueCouponPool -> codes and harvest redeemable codes.
export default factories.createCoreRouter('api::coupon.coupon', {
  only: [],
});
