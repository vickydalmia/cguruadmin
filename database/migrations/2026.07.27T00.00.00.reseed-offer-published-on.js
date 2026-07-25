"use strict";

const {
  reconcileContentContractAfterSchemaSync,
} = require("../content-contract-reconciliation");

/**
 * Safety net for `published_on` after a WordPress re-import.
 *
 * THE FAILURE THIS PREVENTS: `published_on` is the sort key behind every
 * "newest first" listing, and Postgres orders NULLs FIRST in a DESC sort. So a
 * row with no `published_on` outranks every row an editor has actually dated —
 * "Bump to top" would push an offer to the BOTTOM of the site. That stays
 * invisible while the column is uniformly NULL (everything ties and falls
 * through to the `published_at` tiebreaker) and only appears the first time
 * someone bumps an offer, which makes it a nasty one to diagnose.
 *
 * Phases 07/08 of the WP migration now seed `published_on` at insert time, so
 * this should find nothing. It exists because the earlier backfill
 * (2026.07.26T00.00.00) is already recorded in `strapi_migrations` and will NOT
 * re-run after content is re-imported — leaving no net under a re-import done
 * with an older build of the migration workspace.
 *
 * Fill-only and idempotent: an editor-set date is never overwritten.
 */
module.exports = {
  async up(knex) {
    await reconcileContentContractAfterSchemaSync(knex);
  },
};
