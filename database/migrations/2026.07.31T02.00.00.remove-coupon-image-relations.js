"use strict";

const MORPH_TABLE = "files_related_mph";
const COUPON_TYPE = "api::coupon.coupon";
const COUPON_IMAGE_FIELD = "image";

/**
 * Remove only the obsolete Coupon-to-media associations.
 *
 * The files rows and provider objects deliberately remain intact: the same
 * upload can still be referenced by homepage banners, notification overrides,
 * or another content type. Strapi does not clean removed media attributes out
 * of the polymorphic relation table during schema sync, so this explicit,
 * scoped delete prevents stale Coupon image links from lingering forever.
 */
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(MORPH_TABLE))) return;

    await knex(MORPH_TABLE)
      .where({
        related_type: COUPON_TYPE,
        field: COUPON_IMAGE_FIELD,
      })
      .del();
  },
};
