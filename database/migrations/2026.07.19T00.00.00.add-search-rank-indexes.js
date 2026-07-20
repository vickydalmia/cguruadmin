"use strict";

const {
  EXPECTED_SEARCH_INDEX_TARGETS,
  acquireSearchReconcileLock,
  configureOptionalDdlTimeouts,
  ensurePgTrgm,
  isPostgres,
  reconcileSearchIndexes,
} = require("../search-index-migration");

/**
 * Support indexes for the raw-SQL ranked /search queries (search-sql.ts).
 * Pure optimization with the same graceful degradation as
 * 2026.07.12T01.00.00.add-public-search-indexes.js: a locked-down role that
 * may not CREATE EXTENSION must not block Strapi boot. Search ordering never
 * calls pg_trgm functions, so the extension and indexes affect speed only.
 *
 * Index inventory — each justified against the ranked SQL:
 * - ASCII-folded slug trigram GIN on stores/brands/categories/banks: the
 *   ranked WHERE probes `translate(slug, A-Z, a-z) LIKE '<needle>%'` both
 *   directly and inside the
 *   relation EXISTS subqueries; Strapi's unique slug index is on the raw
 *   column and cannot serve the translate() expression.
 * - ASCII-folded code trigram GIN on coupons: the coupon-code containment
 *   probe has no existing expression index.
 * - ASCII-folded name/title indexes from 2026.07.12 are reconciled again here. A
 *   migration can be recorded after an expected permission/lock failure, so
 *   this later migration must repair every expected index, not only new ones.
 * - No link-table indexes: Strapi 5 creates a `_fk` index on the owner
 *   column of every `_lnk` table (see @strapi/database metadata/relations),
 *   which covers the EXISTS probes on coupon_id/deal_id.
 * - No raw-column gin_trgm_ops indexes: the non-Postgres fallback performs
 *   literal full-set membership in JavaScript.
 */
module.exports = {
  async up(knex) {
    if (!isPostgres(knex)) return;
    await configureOptionalDdlTimeouts(knex);
    const migrationName = "add-search-rank-indexes";
    if (!(await acquireSearchReconcileLock(knex, migrationName))) return;
    const pgTrgmSchema = await ensurePgTrgm(knex, migrationName);
    if (!pgTrgmSchema) return;
    await reconcileSearchIndexes(
      knex,
      migrationName,
      EXPECTED_SEARCH_INDEX_TARGETS,
      pgTrgmSchema,
      console,
      { stopAfterOptionalFailure: true },
    );
  },
};
