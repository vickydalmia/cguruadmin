import { factories } from '@strapi/strapi';

// Core routes are disabled: the public frontend consumes deals only through the
// hardened custom controllers (homepage-full, entity offers), which fully
// control `populate`. See coupon/routes/coupon.ts for rationale.
export default factories.createCoreRouter('api::deal.deal', {
  only: [],
});
