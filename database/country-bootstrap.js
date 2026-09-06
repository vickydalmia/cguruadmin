'use strict';

// An explicit, temporary identity for an empty installation. Never infer a
// country from the hostname or rewrite an existing Country Setup record.
function readCountryBootstrap(expected, raw = process.env.COUNTRY_SETUP_BOOTSTRAP_JSON) {
  if (!raw) return null;
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('COUNTRY_SETUP_BOOTSTRAP_JSON must be valid JSON'); }
  const fields = ['siteName', 'countryName', 'countryCode', 'locale', 'timezone', 'currencyCode'];
  if (!input || fields.some((key) => typeof input[key] !== 'string' || !input[key].trim())) {
    throw new Error(`Country bootstrap requires ${fields.join(', ')}`);
  }
  const value = Object.fromEntries(fields.map((key) => [key, input[key].trim()]));
  if (!/^[A-Z]{2}$/.test(expected || '') || value.countryCode !== expected) {
    throw new Error('Country bootstrap must match DEPLOYMENT_COUNTRY_CODE');
  }
  if (!/^[A-Z]{3}$/.test(value.currencyCode)) throw new Error('Invalid bootstrap currencyCode');
  const locale = new Intl.Locale(value.locale);
  if (locale.language !== 'en' || locale.region !== expected) throw new Error('Bootstrap locale must be English for the deployment country');
  new Intl.DateTimeFormat(value.locale, { timeZone: value.timezone }).format();
  return value;
}

async function assertEmptyCountryDatabase(db) {
  const { TABLES } = require('./migrations/2026.09.08T00.00.00.preserve-legacy-english-content.js');
  for (const table of TABLES) {
    if (await db.schema.hasTable(table) && await db(table).select('id').first()) {
      throw new Error(`Country bootstrap requires an empty content database; found records in ${table}`);
    }
  }
}
module.exports = { readCountryBootstrap, assertEmptyCountryDatabase };
