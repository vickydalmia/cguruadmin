"use strict";

const TABLE = "isr_outbox";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;
    const hasAcceptedAt = await knex.schema.hasColumn(TABLE, "accepted_at");
    const hasReceipt = await knex.schema.hasColumn(TABLE, "delivery_receipt");
    if (hasAcceptedAt && hasReceipt) return;

    await knex.schema.alterTable(TABLE, (table) => {
      if (!hasAcceptedAt) {
        table.timestamp("accepted_at", { useTz: true }).nullable();
      }
      if (!hasReceipt) table.jsonb("delivery_receipt").nullable();
    });
  },
};
