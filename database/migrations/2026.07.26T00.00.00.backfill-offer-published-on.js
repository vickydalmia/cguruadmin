"use strict";

const {
  reconcileContentContractAfterSchemaSync,
} = require("../content-contract-reconciliation");

/**
 * Seed the new editor-controlled `published_on` from Strapi's own
 * `published_at` on every existing coupon/deal.
 *
 * WHY: every "newest first" listing used to sort on `published_at`, which with
 * `draftAndPublish: false` is stamped once at creation and is neither editable
 * nor visible in the admin form. `published_on` replaces it as the sort key so
 * editors can re-date an offer and resurface it (see the "Bump to top" action).
 * The sorts read `published_on:desc` with `published_at:desc` only as a
 * tiebreaker. Postgres places NULL first for descending sorts, so one null row
 * can outrank every explicitly dated row and make "Bump to top" look inverted.
 *
 * Fill-only, so it is safe to re-run and never clobbers an editor-set date.
 * Bootstrap invokes the same helper after schema sync because this user
 * migration can be recorded before the new column exists on an existing DB.
 */
module.exports = {
  async up(knex) {
    await reconcileContentContractAfterSchemaSync(knex);
  },
};
