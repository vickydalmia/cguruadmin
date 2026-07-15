"use strict";

const ENTITY_TABLES = ["stores", "brands", "categories", "banks"];

async function addBooleanColumn(knex, table, column) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => {
    t.boolean(column).notNullable().defaultTo(false);
  });
}

/**
 * Shared verification/website fields and the entity-aware anonymous-rating
 * dedupe table. Existing Store votes are copied without exposing raw IPs.
 */
module.exports = {
  async up(knex) {
    for (const table of ENTITY_TABLES) {
      await addBooleanColumn(knex, table, "is_verified");
    }

    if (await knex.schema.hasTable("stores")) {
      await knex("stores").where({ is_verified: false }).update({ is_verified: true });
    }

    for (const table of ENTITY_TABLES) {
      if (
        (await knex.schema.hasTable(table)) &&
        !(await knex.schema.hasColumn(table, "website_url"))
      ) {
        await knex.schema.alterTable(table, (t) => {
          t.string("website_url");
        });
      }
    }

    if (!(await knex.schema.hasTable("entity_rating_votes"))) {
      await knex.schema.createTable("entity_rating_votes", (t) => {
        t.increments("id").primary();
        t.string("entity_type", 16).notNullable();
        t.string("entity_document_id", 255).notNullable();
        t.string("ip_hash", 64).notNullable();
        t.smallint("value").notNullable();
        t.timestamp("created_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());
        t.unique(["entity_type", "entity_document_id", "ip_hash"]);
        t.index(["entity_type", "entity_document_id"]);
      });
    }

    const canBackfill =
      (await knex.schema.hasTable("store_rating_votes")) &&
      (await knex.schema.hasTable("stores")) &&
      (await knex.schema.hasColumn("stores", "document_id"));
    if (!canBackfill) return;

    const oldVotes = await knex("store_rating_votes as vote")
      .join("stores as store", "store.id", "vote.store_id")
      .whereNotNull("store.document_id")
      .select([
        "store.document_id as entity_document_id",
        "vote.ip_hash",
        "vote.value",
        "vote.created_at",
      ]);

    for (let start = 0; start < oldVotes.length; start += 500) {
      const rows = oldVotes.slice(start, start + 500).map((vote) => ({
        entity_type: "store",
        entity_document_id: vote.entity_document_id,
        ip_hash: vote.ip_hash,
        value: vote.value,
        created_at: vote.created_at,
      }));
      if (rows.length > 0) {
        await knex("entity_rating_votes")
          .insert(rows)
          .onConflict(["entity_type", "entity_document_id", "ip_hash"])
          .ignore();
      }
    }
  },
};
