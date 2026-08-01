"use strict";

const TABLE = "files";
const INDEX = "files_bg_removal_source_version_uq";

// Postgres definition, exported so the WordPress importer's preflight can
// re-create the index on fresh databases: this migration runs BEFORE schema
// sync, so on an empty DB `files` doesn't exist yet, the guard below no-ops,
// and the migration is recorded forever. The columns themselves come back via
// schema sync (src/extensions/upload/strapi-server.ts) — only the index would
// be silently lost. migration/src/phases/00-preflight.ts requires these.
const INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}"
         ON "${TABLE}" ("background_removal_source_hash", "background_removal_version")
         WHERE "background_removal_source_hash" IS NOT NULL
           AND "background_removal_version" IS NOT NULL`;

module.exports = {
  INDEX_NAME: INDEX,
  indexSql: INDEX_SQL,
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
      await knex.raw(INDEX_SQL);
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
