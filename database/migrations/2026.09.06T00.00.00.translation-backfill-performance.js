"use strict";

const STATE_TABLE = "translation_state";
const RUNS_TABLE = "translation_backfill_runs";

function isPostgres(knex) {
  return ["pg", "postgres", "postgresql"].includes(
    String(knex.client.config.client || "").toLowerCase(),
  );
}

module.exports = {
  async up(knex) {
    if (
      (await knex.schema.hasTable(STATE_TABLE)) &&
      !(await knex.schema.hasColumn(STATE_TABLE, "published_plan_hash"))
    ) {
      await knex.schema.alterTable(STATE_TABLE, (table) => {
        table.string("published_plan_hash", 64).nullable();
      });
    }

    if (
      (await knex.schema.hasTable(RUNS_TABLE)) &&
      !(await knex.schema.hasColumn(RUNS_TABLE, "checkpoint"))
    ) {
      const postgres = isPostgres(knex);
      await knex.schema.alterTable(RUNS_TABLE, (table) => {
        postgres
          ? table.jsonb("checkpoint").nullable()
          : table.json("checkpoint").nullable();
      });
    }
  },
};
