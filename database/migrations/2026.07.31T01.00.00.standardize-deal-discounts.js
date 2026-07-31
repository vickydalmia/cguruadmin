"use strict";

const TABLE = "deals";
const PREFIX_COLUMN = "discount_prefix";

const PREFIXES = [
  { pattern: /^flat\s+/i, value: "flat" },
  { pattern: /^(?:up\s*to|upto)\s+/i, value: "upTo" },
  { pattern: /^extra\s+/i, value: "extra" },
  { pattern: /^min\s+/i, value: "min" },
  { pattern: /^under\s+/i, value: "under" },
  { pattern: /^below\s+/i, value: "below" },
];

const PERCENT_AMOUNT = /^\d{1,3}(?:\.\d+)?\s*%$/;

function normalizeAmount(value) {
  const trimmed = value.trim();
  if (PERCENT_AMOUNT.test(trimmed)) return trimmed.replace(/\s+/g, "");
  const currency = trimmed.match(/^(₹|rs\.?|inr|\$)\s*(\d[\d,]*)$/i);
  if (!currency) return null;
  const symbol = /\$/.test(currency[1]) ? "$" : "₹";
  return symbol + currency[2].replace(/[^\d]/g, "");
}

function parseLegacyDiscount(value) {
  if (typeof value !== "string") return null;
  const withoutOff = value.trim().replace(/\s+off\s*$/i, "").trim();
  if (!withoutOff) return null;

  for (const prefix of PREFIXES) {
    if (!prefix.pattern.test(withoutOff)) continue;
    const amount = normalizeAmount(withoutOff.replace(prefix.pattern, "").trim());
    return amount ? { discount_prefix: prefix.value, discount: amount } : null;
  }
  return null;
}

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;
    if (!(await knex.schema.hasColumn(TABLE, PREFIX_COLUMN))) {
      await knex.schema.alterTable(TABLE, (table) => {
        table.string(PREFIX_COLUMN).nullable();
      });
    }

    const rows = await knex(TABLE)
      .select("id", "discount")
      .whereNull(PREFIX_COLUMN)
      .whereNotNull("discount");

    for (const row of rows) {
      const parsed = parseLegacyDiscount(row.discount);
      if (!parsed) continue;
      await knex(TABLE)
        .where({ id: row.id, discount: row.discount })
        .whereNull(PREFIX_COLUMN)
        .update(parsed);
    }
  },
  // Exported only so Vitest can pin migration/runtime parser parity.
  parseLegacyDiscount,
};
