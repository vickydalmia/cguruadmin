"use strict";

/**
 * Per-vote records for store ratings. The aggregate columns on `stores`
 * (rating_average / rating_count, seeded from WordPress) stay authoritative;
 * this table exists so one client cannot vote twice on the same store — the
 * UNIQUE(store_id, ip_hash) constraint survives restarts and multiple nodes,
 * unlike the previous in-process dedupe map. IPs are stored only as salted
 * SHA-256 hashes.
 */
module.exports = {
  async up(knex) {
    const exists = await knex.schema.hasTable("store_rating_votes");
    if (exists) return;
    // Fresh database: user migrations run BEFORE Strapi's schema sync, so
    // `stores` does not exist yet and the FK below would fail the whole boot.
    // Skipping is correct, not just safe — this table is legacy (superseded by
    // entity_rating_votes in 2026.07.15T00), kept in sync only where it
    // already exists (entity-page.ts dual-writes behind a hasTable check).
    // A fresh deployment must never create it.
    if (!(await knex.schema.hasTable("stores"))) return;
    await knex.schema.createTable("store_rating_votes", (t) => {
      t.increments("id").primary();
      t.integer("store_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("stores")
        .onDelete("CASCADE");
      t.string("ip_hash", 64).notNullable();
      t.smallint("value").notNullable();
      t.timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
      t.unique(["store_id", "ip_hash"]);
    });
  },
};
