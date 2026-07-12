"use strict";

/**
 * The `excerpt` field was removed from the coupon and deal content types —
 * card summaries are derived from `content` in the frontend instead.
 *
 * Strapi's schema sync auto-drops the columns in environments where the DB
 * role has ALTER rights; this guarded migration makes the drop deterministic
 * on locked-down databases too. Idempotent either way.
 */
module.exports = {
  async up(knex) {
    for (const table of ["coupons", "deals"]) {
      const hasColumn = await knex.schema.hasColumn(table, "excerpt");
      if (hasColumn) {
        await knex.schema.alterTable(table, (t) => {
          t.dropColumn("excerpt");
        });
      }
    }
  },
};
