"use strict";

/**
 * Product Deals now use the editor-authored `discount` field as their only
 * promotional label. Coupon `offer_text` remains intact.
 *
 * Strapi may remove a deleted scalar during schema sync; this guarded
 * migration makes the Deal-only column cleanup deterministic and idempotent
 * on databases where schema sync cannot alter existing tables.
 */
module.exports = {
  async up(knex) {
    const hasColumn = await knex.schema.hasColumn("deals", "offer_text");
    if (!hasColumn) return;

    await knex.schema.alterTable("deals", (table) => {
      table.dropColumn("offer_text");
    });
  },
};
