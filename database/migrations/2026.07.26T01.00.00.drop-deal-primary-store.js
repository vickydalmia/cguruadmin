"use strict";

const LINK_TABLE = "deals_primary_store_lnk";

/**
 * Drop the orphaned link table left behind by removing `deal.primaryStore`.
 *
 * WHY IT IS SAFE: before the field was removed, every one of the 727 rows in
 * this table named a store the deal ALREADY carried in its `stores` taxonomy
 * (verified: zero rows in this table lacked a matching `deals_stores_lnk`
 * row). The relation was pure duplication, which is why every consumer had to
 * query `$or: [{stores}, {primaryStore}]`. The WP migration (phase 12) now
 * folds the ACF `deal_store` value straight into `stores`, so nothing writes
 * here any more.
 *
 * Strapi does not drop tables for removed attributes, so without this the
 * table lingers forever holding stale FK rows.
 *
 * The guard below re-checks the duplication invariant AT MIGRATION TIME rather
 * than trusting the snapshot above: if this database somehow holds a primary
 * store that is NOT in the taxonomy, dropping the table would silently lose
 * that association, so the rows are copied across before the drop instead.
 * Idempotent — a second run finds no table and returns.
 */
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(LINK_TABLE))) return;

    if (await knex.schema.hasTable("deals_stores_lnk")) {
      // Preserve any primary store the taxonomy does not already carry.
      const [{ count }] = await knex.raw(
        `SELECT COUNT(*)::int AS count
           FROM ${LINK_TABLE} p
          WHERE NOT EXISTS (
            SELECT 1 FROM deals_stores_lnk s
             WHERE s.deal_id = p.deal_id AND s.store_id = p.store_id
          )`
      ).then((r) => r.rows ?? r);

      if (Number(count) > 0) {
        await knex.raw(
          `INSERT INTO deals_stores_lnk (deal_id, store_id, deal_ord)
           SELECT p.deal_id, p.store_id, NULL
             FROM ${LINK_TABLE} p
            WHERE NOT EXISTS (
              SELECT 1 FROM deals_stores_lnk s
               WHERE s.deal_id = p.deal_id AND s.store_id = p.store_id
            )
           ON CONFLICT DO NOTHING`
        );
      }

      // Make the former primary store the deterministic first stores[] entry,
      // then densely re-number every affected Deal's remaining stores.
      await knex.raw(
        `WITH ranked AS (
           SELECT s.id,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.deal_id
                    ORDER BY
                      CASE WHEN p.store_id IS NOT NULL THEN 0 ELSE 1 END,
                      s.deal_ord NULLS LAST,
                      s.id
                  ) AS next_ord
             FROM deals_stores_lnk s
             LEFT JOIN ${LINK_TABLE} p
               ON p.deal_id = s.deal_id AND p.store_id = s.store_id
            WHERE EXISTS (
              SELECT 1 FROM ${LINK_TABLE} owned
               WHERE owned.deal_id = s.deal_id
            )
         )
         UPDATE deals_stores_lnk s
            SET deal_ord = ranked.next_ord
           FROM ranked
          WHERE ranked.id = s.id`
      );
    }

    await knex.schema.dropTableIfExists(LINK_TABLE);
  },
};
