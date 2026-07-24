"use strict";

const {
  reconcileUniqueCodeIntegrity,
} = require("../unique-code-integrity");

/**
 * Deployment procedure: briefly pause admin/import writers while this
 * migration deduplicates stock through Strapi's relation table and installs
 * the PostgreSQL relation/code guards.
 * Redemption history wins deterministically when duplicate rows already
 * exist; pool counters are recalculated from the retained rows.
 */
module.exports = {
  async up(knex) {
    await reconcileUniqueCodeIntegrity(knex, console);
  },
};
