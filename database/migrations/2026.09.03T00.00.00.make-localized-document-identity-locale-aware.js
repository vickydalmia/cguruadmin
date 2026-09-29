"use strict";

// Strapi i18n stores every locale version as a separate physical row while
// keeping one document_id for the logical document. A unique(document_id)
// index therefore makes the first translated row impossible to insert.
//
// The WordPress migration used to add that invalid index to these six tables.
// Replace it with unique(document_id, locale), after normalising legacy source
// rows whose raw importer left locale NULL. The translation/outbox tables are
// deliberately untouched: queued work and translation memory survive this
// repair and resume after deployment.

const DEFAULT_CONTENT_LOCALE = "en";
const LOCALIZED_DOCUMENT_TABLES = [
  "stores",
  "brands",
  "categories",
  "banks",
  "coupons",
  "deals",
];

function legacyDocumentIndex(table) {
  return `${table}_document_id_uq`;
}

function localizedDocumentIndex(table) {
  return `${table}_document_id_locale_uq`;
}

// BTRIM is PostgreSQL's name for the standard TRIM(x); SQLite (local
// development) only knows the latter. Same result on both. A connection that
// does not identify itself (unit-test doubles) keeps the Postgres SQL.
function trimFunction(knex) {
  const client = String(knex?.client?.config?.client || "").toLowerCase();
  return client === "" || ["pg", "postgres", "postgresql"].includes(client) ? "BTRIM" : "TRIM";
}

module.exports = {
  async up(knex) {
    for (const table of LOCALIZED_DOCUMENT_TABLES) {
      if (!(await knex.schema.hasTable(table))) continue;

      await knex.raw(`DROP INDEX IF EXISTS "${legacyDocumentIndex(table)}"`);
      await knex.raw(
        `UPDATE "${table}"
            SET "locale" = ?
          WHERE "document_id" IS NOT NULL
            AND NULLIF(${trimFunction(knex)}("locale"), '') IS NULL`,
        [DEFAULT_CONTENT_LOCALE],
      );
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${localizedDocumentIndex(table)}"
           ON "${table}" ("document_id", "locale")`,
      );
    }
  },
  DEFAULT_CONTENT_LOCALE,
  LOCALIZED_DOCUMENT_TABLES,
  legacyDocumentIndex,
  localizedDocumentIndex,
};
