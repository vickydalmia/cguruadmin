"use strict";

// Storefront UI-text dictionary. The storefront owns the KEYS: it pushes its
// flattened English catalogue (POST /api/ui-dictionary/catalogue) and the
// admin stores it here, optionally with an English override, plus one row
// per (locale, key) for every other language — AI-generated or hand-edited.
//
// `hash` fingerprints the pushed English (`sha256([text, max_length])`);
// `effective_hash` fingerprints what the UI shows and what the AI translates
// FROM (`sha256([override_text ?? text, max_length])`). The prompt
// fingerprint is deliberately NOT part of either hash: a prompt tweak must
// never mark a hand-written translation stale. A translation row is current
// while its `source_hash` equals the catalogue row's `effective_hash`;
// otherwise it is stale and the dispatcher re-translates that one key.
//
// Keys the storefront stops pushing are soft-removed (`removed_at`) so a
// rollback deploy revives them together with their translations.

const CATALOGUE_TABLE = "ui_catalogue";
const TRANSLATIONS_TABLE = "ui_translations";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(CATALOGUE_TABLE))) {
      await knex.schema.createTable(CATALOGUE_TABLE, (table) => {
        // Dotted namespace key, e.g. `offers.showDetails`; plural forms are
        // pushed flattened (`offers.count.one`) with `plural_of` set.
        table.string("key", 255).primary();
        table.text("text").notNullable();
        table.text("description").nullable();
        table.integer("max_length").nullable();
        table.string("plural_of", 255).nullable();
        table.string("hash", 64).notNullable();
        table.text("override_text").nullable();
        table.string("effective_hash", 64).notNullable();
        table.integer("override_updated_by").nullable();
        table.timestamp("override_updated_at", { useTz: true }).nullable();
        table
          .timestamp("first_seen_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());
        table
          .timestamp("last_seen_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());
        table.timestamp("removed_at", { useTz: true }).nullable();

        table.index(["removed_at"], "ui_catalogue_removed_idx");
      });
    }

    if (!(await knex.schema.hasTable(TRANSLATIONS_TABLE))) {
      await knex.schema.createTable(TRANSLATIONS_TABLE, (table) => {
        table.string("locale", 16).notNullable();
        table.string("key", 255).notNullable();
        table.text("text").notNullable();
        // The catalogue `effective_hash` this translation was made from.
        table.string("source_hash", 64).notNullable();
        table.string("origin", 16).notNullable();
        table.integer("updated_by").nullable();
        table
          .timestamp("updated_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());

        table.primary(["locale", "key"]);
        table.index(["locale", "source_hash"], "ui_translations_source_idx");
      });
      await knex.raw(
        `ALTER TABLE ${TRANSLATIONS_TABLE} ADD CONSTRAINT ui_translations_origin_check ` +
          `CHECK (origin IN ('ai', 'manual'))`,
      );
    }
  },
};
