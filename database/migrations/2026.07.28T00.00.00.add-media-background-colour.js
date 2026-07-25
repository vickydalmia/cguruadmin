"use strict";

const TABLE = "files";
const COLUMN = "background_colour";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;
    if (await knex.schema.hasColumn(TABLE, COLUMN)) return;

    await knex.schema.alterTable(TABLE, (table) => {
      table.string(COLUMN, 7).nullable();
    });
  },
};
