"use strict";

// Immutable schema inventory for this upgrade. Only locale is repaired;
// IDs, timestamps, components, links and publication state are preserved.
const TABLES = [
  "about_pages",
  "affiliate_disclosure_pages",
  "banks",
  "brands",
  "career_pages",
  "categories",
  "contact_pages",
  "coupons",
  "culture_pages",
  "deals",
  "deal_of_the_day_pages",
  "error_pages",
  "faq_pages",
  "footers",
  "globals",
  "homepages",
  "independence_day_sale_pages",
  "jobs",
  "menus",
  "partner_with_us_pages",
  "privacy_policy_pages",
  "stores",
  "terms_and_conditions_pages",
  "testimonials_pages"
];
// Only the Postgres statements need a dialect guard: the lock policy and the
// table lock have no SQLite equivalent, and BTRIM is a PostgreSQL name for the
// standard TRIM(x) (same result: surrounding spaces removed). Postgres keeps
// running the exact SQL it always did; a connection that does not identify
// itself (unit-test doubles) is treated as Postgres.
function isPostgres(knex) {
  const client = String(knex?.client?.config?.client || "").toLowerCase();
  return client === "" || ["pg", "postgres", "postgresql"].includes(client);
}
function trimFunction(knex) {
  return isPostgres(knex) ? "BTRIM" : "TRIM";
}

const SINGLE_TYPES = new Set(["about_pages", "affiliate_disclosure_pages", "career_pages", "contact_pages", "culture_pages", "deal_of_the_day_pages", "error_pages", "faq_pages", "footers", "globals", "homepages", "independence_day_sale_pages", "menus", "partner_with_us_pages", "privacy_policy_pages", "terms_and_conditions_pages", "testimonials_pages"]);

async function checkTable(trx, table) {
  const hasLocale = await trx.schema.hasColumn(table, 'locale');
  const normalized = hasLocale ? `COALESCE(NULLIF(${trimFunction(trx)}(locale), ''), 'en')` : "CAST('en' AS text)";
  const collisions = await trx(table).select('document_id')
    .select(trx.raw(`${normalized} AS normalized_locale`))
    .groupBy('document_id').groupByRaw(normalized)
    .havingRaw('COUNT(*) > 1').limit(10);
  if (collisions.length) {
    throw new Error(`English locale repair conflict in ${table}: ${JSON.stringify(collisions)}; no rows were changed`);
  }
  if (SINGLE_TYPES.has(table)) {
    const duplicates = await trx(table).select(trx.raw(`${normalized} AS normalized_locale`))
      .groupByRaw(normalized).havingRaw('COUNT(*) > 1').limit(10);
    if (duplicates.length) throw new Error(`Multiple single-type records in ${table}: ${JSON.stringify(duplicates)}; resolve before upgrading`);
  }
}

async function audit(knex) {
  for (const table of TABLES) {
    if (await knex.schema.hasTable(table)) await checkTable(knex, table);
  }
}

async function up(knex) {
  await knex.transaction(async (trx) => {
    const postgres = isPostgres(trx);
    if (postgres) await trx.raw("SET LOCAL lock_timeout = '15s'");
    const existing = [];
    for (const table of TABLES) {
      if (!(await trx.schema.hasTable(table))) continue;
      // Migrations precede Strapi schema synchronization on legacy installs.
      if (!(await trx.schema.hasColumn(table, 'locale'))) {
        await trx.schema.alterTable(table, (t) => t.string('locale', 255));
      }
      if (postgres) await trx.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', [table]);
      await checkTable(trx, table);
      existing.push(table);
    }
    for (const table of existing) {
      await trx(table).whereRaw(`NULLIF(${trimFunction(trx)}(locale), '') IS NULL`).update({ locale: 'en' });
    }
  });
}
module.exports = { up, audit, TABLES };
