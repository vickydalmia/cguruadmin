"use strict";

const TABLE = "files";
const INDEX = "files_bg_removal_source_version_uq";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;

    const columns = [
      ["background_removal_source_hash", (table) => table.string("background_removal_source_hash", 64).nullable()],
      ["background_removal_version", (table) => table.string("background_removal_version", 80).nullable()],
      ["background_removed_at", (table) => table.timestamp("background_removed_at", { useTz: true }).nullable()],
    ];

    for (const [name, add] of columns) {
      if (await knex.schema.hasColumn(TABLE, name)) continue;
      await knex.schema.alterTable(TABLE, (table) => add(table));
    }

    const dialect = knex.client.config.client;
    if (dialect === "pg" || dialect === "postgresql") {
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}"
         ON "${TABLE}" ("background_removal_source_hash", "background_removal_version")
         WHERE "background_removal_source_hash" IS NOT NULL
           AND "background_removal_version" IS NOT NULL`,
      );
    } else {
      await knex.schema.alterTable(TABLE, (table) => {
        table.unique(
          ["background_removal_source_hash", "background_removal_version"],
          { indexName: INDEX },
        );
      });
    }
  },
};
