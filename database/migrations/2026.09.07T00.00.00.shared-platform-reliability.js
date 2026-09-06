'use strict';

module.exports = {
  async up(knex) {
    if (await knex.schema.hasTable('site_configurations') &&
        !await knex.schema.hasColumn('site_configurations', 'configuration_revision')) {
      await knex.schema.alterTable('site_configurations', (table) => {
        table.integer('configuration_revision').notNullable().defaultTo(0);
      });
    }
    if (await knex.schema.hasTable('translation_state') &&
        !await knex.schema.hasColumn('translation_state', 'leaf_source_hashes')) {
      await knex.schema.alterTable('translation_state', (table) => {
        table.jsonb('leaf_source_hashes').nullable();
      });
    }
    if (!await knex.schema.hasTable('translation_worker_heartbeats')) {
      await knex.schema.createTable('translation_worker_heartbeats', (table) => {
        table.string('worker_id', 80).primary();
        table.timestamp('heartbeat_at').notNullable();
        table.string('state', 32).notNullable();
      });
    }
  },
};
