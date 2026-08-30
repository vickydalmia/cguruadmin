"use strict";

// AI-translation job queue + per-locale translation bookkeeping. Clone of
// the ISR outbox shape (2026.07.24 + its hardening follow-ups collapsed
// into one table): durable Postgres rows, lease-claimed processing, token
// and cost audit columns. `translation_state` records, per document and
// target locale, the source-content hash its stored translation was made
// from — the no-op/staleness signal the dispatcher and the admin panel key
// on.

const OUTBOX_TABLE = "translation_outbox";
const STATE_TABLE = "translation_state";
const USAGE_TABLE = "translation_usage";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(OUTBOX_TABLE))) {
      await knex.schema.createTable(OUTBOX_TABLE, (table) => {
        table.bigIncrements("id").primary();
        // `${uid}:${documentId}:${targetLocale}` — the coalescing identity.
        table.string("event_key", 255).notNullable();
        table.string("uid", 255).notNullable();
        table.string("document_id", 64).notNullable();
        table.string("target_locale", 16).notNullable();
        // 'translate' refreshes text AND relations; 'relation-sync' only
        // re-mirrors relations (no LLM call unless the hash turns out stale).
        table.string("kind", 24).notNullable().defaultTo("translate");
        table.boolean("force").notNullable().defaultTo(false);
        table.string("status", 16).notNullable().defaultTo("pending");
        table.integer("attempt_count").notNullable().defaultTo(0);
        table.timestamp("next_attempt_at", { useTz: true }).notNullable();
        table.timestamp("locked_at", { useTz: true }).nullable();
        table.string("lock_token", 64).nullable();
        table.text("last_error").nullable();
        table.bigInteger("tokens_in").notNullable().defaultTo(0);
        table.bigInteger("tokens_out").notNullable().defaultTo(0);
        table.decimal("cost_usd", 12, 6).notNullable().defaultTo(0);
        table.string("reason", 255).notNullable();
        table
          .timestamp("created_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());
        table.timestamp("delivered_at", { useTz: true }).nullable();

        table.index(
          ["status", "next_attempt_at"],
          "translation_outbox_delivery_idx",
        );
        table.index(["status", "locked_at"], "translation_outbox_lease_idx");
        table.index(
          ["status", "delivered_at"],
          "translation_outbox_cleanup_idx",
        );
        table.index(
          ["uid", "document_id"],
          "translation_outbox_document_idx",
        );
      });
      // One PENDING job per document+locale; processing/terminal rows do not
      // block a fresh enqueue (a claim-then-edit race re-enqueues cleanly).
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS translation_outbox_pending_key ` +
          `ON ${OUTBOX_TABLE} (event_key) WHERE status = 'pending'`,
      );
    }

    if (!(await knex.schema.hasTable(STATE_TABLE))) {
      await knex.schema.createTable(STATE_TABLE, (table) => {
        table.string("uid", 255).notNullable();
        table.string("document_id", 64).notNullable();
        table.string("locale", 16).notNullable();
        table.string("source_hash", 64).notNullable();
        table.timestamp("translated_at", { useTz: true }).notNullable();
        table.boolean("needs_review").notNullable().defaultTo(false);
        table.text("review_notes").nullable();
        table.text("last_error").nullable();
        // TRANSLATION MEMORY: the final translated text per leaf path
        // ({ "seo.metaTitle": "…", … }). This is what makes repeated
        // migrate:fresh runs free: the migration truncates the content
        // tables (including the locale rows) but never this table, so a
        // re-import whose English hashes identically rebuilds every locale
        // version from here with zero LLM calls.
        table.jsonb("translations").nullable();
        table.primary(["uid", "document_id", "locale"]);
      });
    } else if (!(await knex.schema.hasColumn(STATE_TABLE, "translations"))) {
      // Dev databases that ran the earlier shape of this migration.
      await knex.schema.alterTable(STATE_TABLE, (table) => {
        table.jsonb("translations").nullable();
      });
    }

    if (!(await knex.schema.hasTable(USAGE_TABLE))) {
      await knex.schema.createTable(USAGE_TABLE, (table) => {
        table.uuid("reservation_id").primary();
        table.bigInteger("job_id").notNullable();
        table.string("event_key", 255).notNullable();
        table.string("target_locale", 16).notNullable();
        table.string("stage", 32).notNullable();
        table.string("provider", 64).notNullable();
        table.string("model", 255).notNullable();
        table.integer("attempt").notNullable();
        // reserved → charged when token usage is known; uncertain keeps the
        // conservative reservation for requests that may still be billed.
        table.string("status", 16).notNullable();
        table.bigInteger("input_tokens").notNullable().defaultTo(0);
        table.bigInteger("output_tokens").notNullable().defaultTo(0);
        table.decimal("cost_usd", 12, 6).notNullable().defaultTo(0);
        table.text("error").nullable();
        table
          .timestamp("created_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());
        table.timestamp("settled_at", { useTz: true }).nullable();

        table.index(["created_at"], "translation_usage_budget_idx");
        table.index(["job_id"], "translation_usage_job_idx");
        table.index(
          ["target_locale", "created_at"],
          "translation_usage_locale_idx",
        );
      });
    }

  },
};
