"use strict";

const ENTITY_TABLES = ["stores", "brands", "categories", "banks"];
const COLUMN = "page_template";

module.exports = {
  async up(knex) {
    for (const tableName of ENTITY_TABLES) {
      if (!(await knex.schema.hasTable(tableName))) continue;
      if (!(await knex.schema.hasColumn(tableName, COLUMN))) {
        await knex.schema.alterTable(tableName, (table) => {
          table.string(COLUMN).notNullable().defaultTo("default");
        });
      }
    }

    // One-time compatibility backfill. Runtime template selection is driven
    // solely by page_template; these legacy slugs are not consulted again.
    if (await knex.schema.hasTable("categories")) {
      await knex("categories")
        .whereIn("slug", ["deal-of-the-day", "categories/deal-of-the-day"])
        .update({ [COLUMN]: "dealTemplate" });
      await knex("categories")
        .whereIn("slug", [
          "independence-day-sale-coupons",
          "categories/independence-day-sale-coupons",
        ])
        .update({ [COLUMN]: "independenceDayTemplate" });
    }
  },
};
