"use strict";

const {
  reconcileSiteSelectionsAfterSchemaSync,
  snapshotLegacyPopularSearchesBeforeSchemaSync,
} = require("../site-selection-reconciliation");

/**
 * Fill-only compatibility backfill. Bootstrap runs the same reconciliation
 * after schema sync because Strapi records user migrations before creating
 * newly introduced component relation tables.
 */
module.exports = {
  async up(knex) {
    await snapshotLegacyPopularSearchesBeforeSchemaSync(knex);
    await reconcileSiteSelectionsAfterSchemaSync(knex);
  },
};
