"use strict";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasColumn("telegram_pending_messages", "error_details"))) {
      await knex.schema.alterTable("telegram_pending_messages", table => {
        table.text("error_details").nullable();
      });
    }
  },
};
