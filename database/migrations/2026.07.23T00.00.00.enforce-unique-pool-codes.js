"use strict";

const {
  reconcileUniqueCodeIntegrity,
} = require("../unique-code-integrity");

/**
 * Deployment procedure: briefly pause admin/import writers while this
 * migration deduplicates stock and creates the blocking unique index.
 * Redemption history wins deterministically when duplicate rows already
 * exist; pool counters are recalculated from the retained rows.
 */
module.exports = {
  async up(knex) {
    await reconcileUniqueCodeIntegrity(knex, console);
  },
};
