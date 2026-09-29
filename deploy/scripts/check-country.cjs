'use strict';

// Read the NEW image's database configuration before Strapi boots or migrates.
// This deliberately uses one read connection and never starts application hooks.
async function checkDatabaseCountry(db, expected, bootstrapJson = process.env.COUNTRY_SETUP_BOOTSTRAP_JSON) {
  if (!/^[A-Z]{2}$/.test(expected || '')) throw new Error('DEPLOYMENT_COUNTRY_CODE is required');
  const exists = await db.schema.hasTable('site_configurations');
  const rows = exists ? await db('site_configurations').select('country_code') : [];
  if (!rows.length && bootstrapJson) {
    const { readCountryBootstrap, assertEmptyCountryDatabase } = require('../../database/country-bootstrap.js');
    readCountryBootstrap(expected, bootstrapJson);
    await assertEmptyCountryDatabase(db);
    return;
  }
  if (!rows.length && expected === 'IN') return; // Explicit legacy India compatibility.
  if (!rows.length || rows.some((row) => row.country_code !== expected)) {
    throw new Error('Target database country does not match this deployment; no migration was started');
  }
}

function preflightDatabaseConfig(databaseConfig) {
  const config = databaseConfig.connection;
  const schema = config.connection?.schema || 'public';
  return { ...config, searchPath: [schema], pool: { min: 0, max: 1 }, acquireConnectionTimeout: 10000 };
}
module.exports = { checkDatabaseCountry, preflightDatabaseConfig };

if (require.main === module) {
  (async () => {
    const { env } = require('@strapi/utils');
    const databaseConfig = require('../../dist/config/database.js').default({ env });
    require('../../database/country-bootstrap.js');
    const repair = require('../../database/migrations/2026.09.08T00.00.00.preserve-legacy-english-content.js');
    if (process.argv.includes('--verify-package')) {
      if (typeof repair.audit !== 'function') throw new Error('Missing English upgrade audit');
      console.log('[deploy] runtime preflight package verified');
      return;
    }
    const db = require('knex')(preflightDatabaseConfig(databaseConfig));
    try {
      await checkDatabaseCountry(db, process.env.DEPLOYMENT_COUNTRY_CODE);
      if (process.env.MAINTENANCE_SERVICE_ENABLED === 'false' && await db.schema.hasTable('site_configurations') &&
          await db.schema.hasColumn('site_configurations', 'translation_enabled')) {
        const enabled = await db('site_configurations').where({ translation_enabled: true }).first();
        if (enabled) throw new Error('Translation is enabled: MAINTENANCE_SERVICE_ENABLED must not be false');
      }
      await repair.audit(db);
      console.log(`[deploy] target database verified for ${process.env.DEPLOYMENT_COUNTRY_CODE}`);
    } finally { await db.destroy(); }
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
