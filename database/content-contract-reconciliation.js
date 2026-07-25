"use strict";

const OFFER_TABLES = ["coupons", "deals"];
const ALT_COLUMN_BY_TABLE = {
  stores: "logo_alt",
  brands: "logo_alt",
  banks: "logo_alt",
  categories: "icon_alt",
};

async function hasColumns(knex, table, columns) {
  if (!(await knex.schema.hasTable(table))) return false;
  for (const column of columns) {
    if (!(await knex.schema.hasColumn(table, column))) return false;
  }
  return true;
}

/**
 * Reconcile content values that depend on columns Strapi may only create
 * during schema sync. Strapi records user migrations before that sync, so the
 * one-shot migrations alone cannot guarantee these values on an existing DB.
 *
 * Fill-only by design: imported/editor-authored values always win, and running
 * this on every bootstrap becomes an inexpensive no-op after the first pass.
 */
async function reconcileContentContractAfterSchemaSync(knex, logger = console) {
  const result = { publishedOn: 0, mediaAlt: 0 };

  for (const table of OFFER_TABLES) {
    if (!(await hasColumns(knex, table, ["published_on", "published_at"]))) {
      continue;
    }

    const updated = await knex(table)
      .whereNull("published_on")
      .whereNotNull("published_at")
      .update({ published_on: knex.ref("published_at") });
    result.publishedOn += Number(updated || 0);
  }

  for (const [table, column] of Object.entries(ALT_COLUMN_BY_TABLE)) {
    if (!(await hasColumns(knex, table, [column, "name"]))) continue;

    const updated = await knex(table)
      .where((builder) =>
        builder
          .whereNull(column)
          .orWhereRaw("btrim(??) = ''", [column]),
      )
      .whereNotNull("name")
      .whereRaw("btrim(??) <> ''", ["name"])
      .update({ [column]: knex.ref("name") });
    result.mediaAlt += Number(updated || 0);
  }

  if (result.publishedOn > 0 || result.mediaAlt > 0) {
    logger.info(
      `[content-contract] reconciled ${result.publishedOn} offer published date(s) ` +
        `and ${result.mediaAlt} entity media alt value(s) after schema sync`,
    );
  }

  return result;
}

module.exports = {
  ALT_COLUMN_BY_TABLE,
  OFFER_TABLES,
  reconcileContentContractAfterSchemaSync,
};
