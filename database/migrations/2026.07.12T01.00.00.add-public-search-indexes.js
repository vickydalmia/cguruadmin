"use strict";

const {
  PUBLIC_SEARCH_INDEX_TARGETS,
  acquireSearchReconcileLock,
  configureOptionalDdlTimeouts,
  ensurePgTrgm,
  isPostgres,
  reconcileSearchIndexes,
} = require("../search-index-migration");

/**
 * Trigram indexes for the public /search LIKE/ILIKE lookups. Pure
 * optimization: search works (slower) without them, so a locked-down DB role
 * that may not CREATE EXTENSION must degrade gracefully instead of blocking
 * Strapi boot.
 */
module.exports = {
  async up(knex) {
    if (!isPostgres(knex)) return;
    await configureOptionalDdlTimeouts(knex);
    const migrationName = "add-public-search-indexes";
    if (!(await acquireSearchReconcileLock(knex, migrationName))) return;
    const pgTrgmSchema = await ensurePgTrgm(knex, migrationName);
    if (!pgTrgmSchema) return;
    await reconcileSearchIndexes(
      knex,
      migrationName,
      PUBLIC_SEARCH_INDEX_TARGETS,
      pgTrgmSchema,
      console,
      { stopAfterOptionalFailure: true },
    );
  },
};
