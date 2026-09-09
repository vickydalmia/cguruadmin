"use strict";

const FIELDS = ["telegram_url", "whatsapp_url", "sendy_url", "sendy_list_id"];
const clean = (value) => typeof value === "string" ? value.trim() : "";

function firstUrl(...values) {
  return values.map(clean).find((value) => {
    try {
      const url = new URL(value);
      return /^https?:\/\//i.test(value) && !/\s/.test(value) &&
        !url.username && !url.password;
    } catch { return false; }
  }) || null;
}

function resolveValues(current, legacy, env) {
  return {
    telegram_url: clean(current?.telegram_url) || firstUrl(legacy.telegram, env.PUBLIC_TELEGRAM_URL, legacy.footerTelegram),
    whatsapp_url: clean(current?.whatsapp_url) || firstUrl(legacy.whatsapp, env.PUBLIC_WHATSAPP_URL),
    sendy_url: clean(current?.sendy_url) || clean(env.SENDY_URL) || null,
    sendy_list_id: clean(current?.sendy_list_id) || clean(env.SENDY_LIST_ID) || null,
  };
}

async function legacyFooter(knex) {
  if (!(await knex.schema.hasTable("footers")) ||
      !(await knex.schema.hasTable("footers_cmps")) ||
      !(await knex.schema.hasTable("components_footer_social_links"))) return {};
  const footer = await knex("footers").where({ locale: "en" }).orderBy("id").first();
  if (!footer) return {};
  const links = await knex("footers_cmps as c")
    .join("components_footer_social_links as s", "s.id", "c.cmp_id")
    .where({ "c.entity_id": footer.id, "c.field": "socialLinks", "c.component_type": "footer.social-link" })
    .orderBy("c.order").select("s.platform", "s.url");
  return {
    footerTelegram: links.find((link) => link.platform === "telegram")?.url,
    whatsapp: links.find((link) => link.platform === "whatsapp")?.url,
  };
}

// Runs BEFORE schema sync removes the old component URL. Environment inputs
// are a one-time import only: stage the four non-secret values on Strapi for
// this upgrade. No API key is ever read, persisted, or logged here.
async function up(knex) {
  if (!(await knex.schema.hasTable("globals"))) return;
  for (const field of FIELDS) {
    if (!(await knex.schema.hasColumn("globals", field))) {
      await knex.schema.alterTable("globals", (table) => table.string(field, field === "sendy_list_id" ? 255 : 2048).nullable());
    }
  }
  const rows = await knex("globals").orderBy("id");
  const source = rows.find((row) => row.locale === "en");
  if (!source) return;
  const legacy = await legacyFooter(knex);
  if (await knex.schema.hasTable("globals_cmps") &&
      await knex.schema.hasColumn("components_shared_telegram_ctas", "cta_url")) {
    const cta = await knex("globals_cmps as c")
      .join("components_shared_telegram_ctas as t", "t.id", "c.cmp_id")
      .where({ "c.entity_id": source.id, "c.field": "telegramCta", "c.component_type": "shared.telegram-cta" })
      .select("t.cta_url").first();
    legacy.telegram = cta?.cta_url;
  }
  const values = resolveValues(source, legacy, process.env);
  for (const row of rows) {
    const patch = Object.fromEntries(FIELDS.filter((field) => !clean(row[field])).map((field) => [field, values[field]]));
    if (Object.keys(patch).length) await knex("globals").where({ id: row.id }).update(patch);
  }
  // Only detach retired channel entries after preserving their destinations.
  // Keep component rows for rollback inspection; they are no longer editable.
  if (await knex.schema.hasTable("footers_cmps") && await knex.schema.hasTable("components_footer_social_links")) {
    await knex("footers_cmps").where({ field: "socialLinks", component_type: "footer.social-link" })
      .whereIn("cmp_id", knex("components_footer_social_links").select("id").whereIn("platform", ["telegram", "whatsapp"]))
      .del();
  }
}

module.exports = { up, resolveValues };
