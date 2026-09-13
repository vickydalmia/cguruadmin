"use strict";

// Private worker state, deliberately outside the public Content API.
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("telegram_worker_leases"))) {
      await knex.schema.createTable("telegram_worker_leases", table => {
        table.string("key", 80).primary();
        table.string("owner", 64).notNullable();
        table.timestamp("expires_at", { useTz: true }).notNullable();
      });
    }
    if (!(await knex.schema.hasTable("telegram_pending_messages"))) {
      await knex.schema.createTable("telegram_pending_messages", table => {
        table.string("id", 64).primary();
        table.string("connection_key", 64).notNullable();
        table.string("chat_id", 32).notNullable();
        table.integer("message_id").notNullable();
        table.bigInteger("update_id").notNullable();
        table.timestamp("posted_at", { useTz: true }).notNullable();
        table.text("message").notNullable();
        table.string("stage", 32).notNullable().defaultTo("pending");
        table.integer("attempts").notNullable().defaultTo(0);
        table.timestamp("next_attempt_at", { useTz: true }).notNullable();
        table.string("error_code", 80).nullable();
        table.string("request_id", 128).nullable();
        table.timestamp("submitted_at", { useTz: true }).nullable();
        table.integer("media_id").nullable();
        table.unique(["connection_key", "chat_id", "message_id"], "telegram_pending_identity");
        table.index(["connection_key", "next_attempt_at"], "telegram_pending_due");
      });
    }
  },
};
