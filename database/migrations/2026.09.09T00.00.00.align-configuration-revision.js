'use strict';

// Some installations synchronized the formerly optional Strapi attribute after
// 09.07. Repair NULL values before schema sync reinstates the column contract.
// A connection that does not identify itself (unit-test doubles) is treated
// as Postgres, like src/utils/database-dialect.ts.
function isPostgres(knex) {
  const client = String(knex?.client?.config?.client || '').toLowerCase();
  return client === '' || ['pg', 'postgres', 'postgresql'].includes(client);
}

module.exports = {
  async up(knex) {
    if (!await knex.schema.hasTable('site_configurations')) return;
    await knex.transaction(async (trx) => {
      if (!await trx.schema.hasColumn('site_configurations', 'configuration_revision')) {
        await trx.schema.alterTable('site_configurations', (table) => {
          table.integer('configuration_revision').notNullable().defaultTo(0);
        });
      } else {
        await trx('site_configurations').whereNull('configuration_revision').update({ configuration_revision: 0 });
        // ALTER COLUMN is PostgreSQL syntax. Other dialects (local SQLite
        // development) rely on Strapi's schema sync, which rebuilds the column
        // contract right after user migrations now that no NULL remains.
        if (isPostgres(trx)) {
          await trx.raw('ALTER TABLE ?? ALTER COLUMN ?? SET DEFAULT 0, ALTER COLUMN ?? SET NOT NULL',
            ['site_configurations', 'configuration_revision', 'configuration_revision']);
        }
      }
    });
  },
};
