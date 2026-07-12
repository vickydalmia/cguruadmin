"use strict";

/**
 * Trigram indexes for the public /search LIKE/ILIKE lookups. Pure
 * optimization: search works (slower) without them, so a locked-down DB role
 * that may not CREATE EXTENSION must degrade gracefully instead of blocking
 * Strapi boot.
 */
module.exports = {
  async up(knex) {
    const client = String(knex?.client?.config?.client || "").toLowerCase();
    if (!["pg", "postgres", "postgresql"].includes(client)) return;
    try {
      await knex.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    } catch (err) {
      console.warn(
        `add-public-search-indexes: cannot enable pg_trgm (${err.message}) — ` +
          "skipping trigram indexes; search stays unindexed",
      );
      return;
    }
    for (const table of ["stores", "brands", "categories", "banks", "coupons", "deals"]) {
      const column = ["coupons", "deals"].includes(table) ? "title" : "name";
      const index = table + "_" + column + "_search_trgm_idx";
      await knex.raw(
        "CREATE INDEX IF NOT EXISTS ?? ON ?? USING gin (lower(??) gin_trgm_ops)",
        [index, table, column],
      );
    }
  },
};
