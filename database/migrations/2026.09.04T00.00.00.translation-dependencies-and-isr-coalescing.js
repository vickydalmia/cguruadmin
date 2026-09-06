"use strict";

const TRANSLATION_OUTBOX = "translation_outbox";
const ISR_OUTBOX = "isr_outbox";

module.exports = {
  async up(knex) {
    const postgres = ["pg", "postgres", "postgresql"].includes(
      String(knex.client.config.client || "").toLowerCase(),
    );
    if (await knex.schema.hasTable(TRANSLATION_OUTBOX)) {
      if (!(await knex.schema.hasColumn(TRANSLATION_OUTBOX, "blocked_on"))) {
        await knex.schema.alterTable(TRANSLATION_OUTBOX, (table) => {
          table.jsonb("blocked_on").nullable();
        });
      }
      if (postgres) {
        await knex.raw(
          `CREATE INDEX IF NOT EXISTS translation_outbox_blocked_on_idx ` +
            `ON ${TRANSLATION_OUTBOX} USING GIN (blocked_on jsonb_path_ops) ` +
            `WHERE status = 'blocked'`,
        );
      }
    }

    if (await knex.schema.hasTable(ISR_OUTBOX)) {
      // The first ISR migration made event_key globally unique, which erased
      // delivery history when a logical key was reused. Pending-only
      // uniqueness coalesces a burst while allowing every delivered attempt
      // to remain auditable.
      if (postgres) {
        await knex.raw(
          `ALTER TABLE ${ISR_OUTBOX} ` +
            `DROP CONSTRAINT IF EXISTS isr_outbox_event_key_unique`,
        );
        await knex.raw(`DROP INDEX IF EXISTS isr_outbox_event_key_unique`);
      } else {
        // SQLite cannot drop a UNIQUE table constraint. Rebuild the dev table
        // once without it, preserving every audit row and its primary key.
        const legacy = `${ISR_OUTBOX}_global_unique`;
        await knex.schema.dropTableIfExists(legacy);
        await knex.raw("DROP INDEX IF EXISTS isr_outbox_delivery_idx");
        await knex.raw("DROP INDEX IF EXISTS isr_outbox_lease_idx");
        await knex.raw("DROP INDEX IF EXISTS isr_outbox_cleanup_idx");
        await knex.schema.renameTable(ISR_OUTBOX, legacy);
        await knex.schema.createTable(ISR_OUTBOX, (table) => {
          table.bigIncrements("id").primary();
          table.string("event_key", 64).notNullable();
          table.json("payload").notNullable();
          table.string("reason", 255).notNullable();
          table.string("status", 16).notNullable().defaultTo("pending");
          table.integer("attempt_count").notNullable().defaultTo(0);
          table.timestamp("next_attempt_at", { useTz: true }).notNullable();
          table.timestamp("locked_at", { useTz: true }).nullable();
          table.uuid("lock_token").nullable();
          table.text("last_error").nullable();
          table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
          table.timestamp("delivered_at", { useTz: true }).nullable();
          table.timestamp("invalid_at", { useTz: true }).nullable();
          table.timestamp("accepted_at", { useTz: true }).nullable();
          table.json("delivery_receipt").nullable();
          table.index(["status", "next_attempt_at"], "isr_outbox_delivery_idx");
          table.index(["status", "locked_at"], "isr_outbox_lease_idx");
          table.index(["status", "delivered_at"], "isr_outbox_cleanup_idx");
        });
        const columns = [
          "id", "event_key", "payload", "reason", "status", "attempt_count",
          "next_attempt_at", "locked_at", "lock_token", "last_error",
          "created_at", "delivered_at", "invalid_at", "accepted_at", "delivery_receipt",
        ];
        await knex(ISR_OUTBOX).insert(knex(legacy).select(columns));
        await knex.schema.dropTable(legacy);
      }
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS isr_outbox_pending_key ` +
          `ON ${ISR_OUTBOX} (event_key) WHERE status = 'pending'`,
      );
    }
  },
};
