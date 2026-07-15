"use strict";

const OFFER_TABLES = ["coupons", "deals"];
// New scalar columns that replace the removed isPopular / cashbackItems.
const NEW_STRING_COLUMNS = ["offer_text", "cashback_text", "bank_offer_text", "badge"];

async function ensureStringColumn(knex, table, column) {
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => {
    t.string(column);
  });
}

/**
 * Preserve legacy offer metadata on ALREADY-migrated coupons/deals BEFORE the
 * old fields are removed. Strapi's schema sync adds the new columns but never
 * copies the old data, so without this an existing DB would keep the orphaned
 * `is_popular` / `cashbackItems` values while `badge` and the cashback texts
 * stay null (and lost once the legacy columns/component are dropped).
 *
 *   badge           ← 'Recommended' where the legacy `is_popular` is true
 *   cashback_text   ← the cashbackItems chip whose label reads "… Cashback"
 *   bank_offer_text ← the cashbackItems chip whose label reads "… Bank …"
 *
 * `offer_text` is NOT legacy data — it is derived from the title — so it is not
 * touched here; fill it (and any still-null cashback/bank text) with
 * `yarn backfill:offer-fields` in the migration workspace, which reuses the
 * shared extractor. All writes are fill-only (whereNull), so editor edits are
 * never clobbered and the migration is safe to re-run.
 */
module.exports = {
  async up(knex) {
    for (const table of OFFER_TABLES) {
      if (!(await knex.schema.hasTable(table))) continue;

      // Defensive: if this runs before Strapi's schema sync, create the new
      // columns so the backfills below have somewhere to write.
      for (const column of NEW_STRING_COLUMNS) {
        await ensureStringColumn(knex, table, column);
      }

      // badge ← is_popular (lossy: is_popular is being removed).
      if (await knex.schema.hasColumn(table, "is_popular")) {
        await knex(table)
          .where({ is_popular: true })
          .whereNull("badge")
          .update({ badge: "Recommended" });
      }

      // cashback_text / bank_offer_text ← existing cashbackItems chips. These
      // hold the actually-displayed values (possibly editor-tuned), so copy
      // them before the shared.chip component and its links are dropped.
      const cmps = `${table}_cmps`;
      if (
        (await knex.schema.hasTable(cmps)) &&
        (await knex.schema.hasTable("components_shared_chips"))
      ) {
        const chips = await knex(`${cmps} as link`)
          .join("components_shared_chips as chip", "chip.id", "link.cmp_id")
          .where("link.field", "cashbackItems")
          .whereNotNull("chip.label")
          .orderBy([{ column: "link.entity_id" }, { column: "link.order" }])
          .select(
            "link.entity_id as entity_id",
            "chip.label as label",
          );

        const cashbackByEntity = new Map();
        const bankByEntity = new Map();
        for (const row of chips) {
          if (!cashbackByEntity.has(row.entity_id) && /cash\s?back/i.test(row.label)) {
            cashbackByEntity.set(row.entity_id, row.label);
          }
          if (!bankByEntity.has(row.entity_id) && /bank/i.test(row.label)) {
            bankByEntity.set(row.entity_id, row.label);
          }
        }

        for (const [entityId, label] of cashbackByEntity) {
          await knex(table)
            .where({ id: entityId })
            .whereNull("cashback_text")
            .update({ cashback_text: label });
        }
        for (const [entityId, label] of bankByEntity) {
          await knex(table)
            .where({ id: entityId })
            .whereNull("bank_offer_text")
            .update({ bank_offer_text: label });
        }
      }
    }
  },
};
