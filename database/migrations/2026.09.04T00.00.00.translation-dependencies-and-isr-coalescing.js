"use strict";

const TRANSLATION_OUTBOX = "translation_outbox";
const ISR_OUTBOX = "isr_outbox";

module.exports = {
  async up(knex) {
    if (await knex.schema.hasTable(TRANSLATION_OUTBOX)) {
      if (!(await knex.schema.hasColumn(TRANSLATION_OUTBOX, "blocked_on"))) {
        await knex.schema.alterTable(TRANSLATION_OUTBOX, (table) => {
          table.jsonb("blocked_on").nullable();
        });
      }
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS translation_outbox_blocked_on_idx ` +
          `ON ${TRANSLATION_OUTBOX} USING GIN (blocked_on jsonb_path_ops) ` +
          `WHERE status = 'blocked'`,
      );
    }

    if (await knex.schema.hasTable(ISR_OUTBOX)) {
      // The first ISR migration made event_key globally unique, which erased
      // delivery history when a logical key was reused. Pending-only
      // uniqueness coalesces a burst while allowing every delivered attempt
      // to remain auditable.
      await knex.raw(
        `ALTER TABLE ${ISR_OUTBOX} ` +
          `DROP CONSTRAINT IF EXISTS isr_outbox_event_key_unique`,
      );
      await knex.raw(`DROP INDEX IF EXISTS isr_outbox_event_key_unique`);
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS isr_outbox_pending_key ` +
          `ON ${ISR_OUTBOX} (event_key) WHERE status = 'pending'`,
      );
    }
  },
};
