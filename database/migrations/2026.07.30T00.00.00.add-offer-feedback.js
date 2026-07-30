"use strict";

const OFFER_TABLES = ["coupons", "deals"];
const COUNTER_COLUMNS = ["worked_count", "failed_count"];

/**
 * Anonymous "worked / failed" offer feedback: per-IP dedupe table plus
 * denormalized counters on coupons and deals. Raw IPs are never stored —
 * only a salted hash, matching entity_rating_votes.
 */
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("offer_feedback_votes"))) {
      await knex.schema.createTable("offer_feedback_votes", (t) => {
        t.increments("id").primary();
        t.string("entity_type", 16).notNullable();
        t.string("entity_document_id", 255).notNullable();
        t.string("ip_hash", 64).notNullable();
        t.string("value", 16).notNullable();
        t.timestamp("created_at", { useTz: true })
          .notNullable()
          .defaultTo(knex.fn.now());
        t.unique(["entity_type", "entity_document_id", "ip_hash"]);
        t.index(["entity_type", "entity_document_id"]);
      });
    }

    for (const table of OFFER_TABLES) {
      if (!(await knex.schema.hasTable(table))) continue;
      for (const column of COUNTER_COLUMNS) {
        if (await knex.schema.hasColumn(table, column)) continue;
        await knex.schema.alterTable(table, (t) => {
          t.integer(column).notNullable().defaultTo(0);
        });
      }
    }
  },
};
