"use strict";

const TABLE = "isr_outbox";

module.exports = {
  async up(knex) {
    if (await knex.schema.hasTable(TABLE)) return;

    await knex.schema.createTable(TABLE, (table) => {
      table.bigIncrements("id").primary();
      table.string("event_key", 64).notNullable().unique();
      table.jsonb("payload").notNullable();
      table.string("reason", 255).notNullable();
      table.string("status", 16).notNullable().defaultTo("pending");
      table.integer("attempt_count").notNullable().defaultTo(0);
      table.timestamp("next_attempt_at", { useTz: true }).notNullable();
      table.timestamp("locked_at", { useTz: true }).nullable();
      table.text("last_error").nullable();
      table.timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
      table.timestamp("delivered_at", { useTz: true }).nullable();

      table.index(["status", "next_attempt_at"], "isr_outbox_delivery_idx");
      table.index(["status", "locked_at"], "isr_outbox_lease_idx");
      table.index(["status", "delivered_at"], "isr_outbox_cleanup_idx");
    });
  },
};
