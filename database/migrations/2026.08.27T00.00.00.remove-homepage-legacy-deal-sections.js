"use strict";

const HOMEPAGE_COMPONENTS = "homepages_cmps";
const REMOVED_FIELDS = ["exploreDeals", "dealsByBrand"];

/**
 * Remove the two obsolete Homepage component attachments deterministically.
 *
 * The underlying home.deal-list and home.explore-deals component schemas stay
 * because campaign single types still use them. Only their retired Homepage
 * fields are removed, so this migration must not drop either shared table.
 */
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(HOMEPAGE_COMPONENTS))) return;

    await knex(HOMEPAGE_COMPONENTS)
      .whereIn("field", REMOVED_FIELDS)
      .del();
  },
};
