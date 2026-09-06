"use strict";

const crypto = require("node:crypto");

const ISR_OUTBOX = "isr_outbox";
const TRANSLATION_OUTBOX = "translation_outbox";
const BACKFILL_RUNS = "translation_backfill_runs";

function isPostgres(knex) {
  return ["pg", "postgres", "postgresql"].includes(
    String(knex.client.config.client || "").toLowerCase(),
  );
}

module.exports = {
  async up(knex) {
    const postgres = isPostgres(knex);

    if (await knex.schema.hasTable(ISR_OUTBOX)) {
      if (!(await knex.schema.hasColumn(ISR_OUTBOX, "delivery_key"))) {
        await knex.schema.alterTable(ISR_OUTBOX, (table) => {
          table.uuid("delivery_key").nullable();
        });
      }
      const rows = await knex(ISR_OUTBOX).whereNull("delivery_key").select("id");
      for (const row of rows) {
        await knex(ISR_OUTBOX)
          .where({ id: row.id })
          .update({ delivery_key: crypto.randomUUID() });
      }
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS isr_outbox_delivery_key_unique ` +
          `ON ${ISR_OUTBOX} (delivery_key)`,
      );
    }

    if (await knex.schema.hasTable(TRANSLATION_OUTBOX)) {
      if (!(await knex.schema.hasColumn(TRANSLATION_OUTBOX, "source_hash"))) {
        await knex.schema.alterTable(TRANSLATION_OUTBOX, (table) => {
          table.string("source_hash", 64).nullable();
        });
      }
      if (!(await knex.schema.hasColumn(TRANSLATION_OUTBOX, "outcome_code"))) {
        await knex.schema.alterTable(TRANSLATION_OUTBOX, (table) => {
          table.string("outcome_code", 48).nullable();
        });
      }
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS translation_outbox_event_latest_idx ` +
          `ON ${TRANSLATION_OUTBOX} (event_key, id DESC)`,
      );
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS translation_outbox_document_locale_latest_idx ` +
          `ON ${TRANSLATION_OUTBOX} (uid, document_id, target_locale, id DESC)`,
      );
    }

    if (!(await knex.schema.hasTable(BACKFILL_RUNS))) {
      await knex.schema.createTable(BACKFILL_RUNS, (table) => {
        table.uuid("id").primary();
        table.string("mode", 16).notNullable();
        table.boolean("dry_run").notNullable().defaultTo(false);
        table.boolean("force").notNullable().defaultTo(false);
        postgres ? table.jsonb("request").notNullable() : table.json("request").notNullable();
        table.string("status", 16).notNullable().defaultTo("pending");
        postgres ? table.jsonb("progress").notNullable() : table.json("progress").notNullable();
        postgres ? table.jsonb("result").nullable() : table.json("result").nullable();
        table.text("last_error").nullable();
        table.timestamp("locked_at", { useTz: true }).nullable();
        table.string("lock_token", 64).nullable();
        table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("finished_at", { useTz: true }).nullable();
        table.index(["status", "created_at"], "translation_backfill_run_status_idx");
      });
      if (postgres) {
        await knex.raw(
          `CREATE UNIQUE INDEX translation_backfill_one_active_idx ON ${BACKFILL_RUNS} ((1)) ` +
            `WHERE status IN ('pending', 'running')`,
        );
      }
    }
  },
};
