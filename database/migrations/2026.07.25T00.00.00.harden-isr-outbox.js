"use strict";

const TABLE = "isr_outbox";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;
    const hasLockToken = await knex.schema.hasColumn(TABLE, "lock_token");
    const hasInvalidAt = await knex.schema.hasColumn(TABLE, "invalid_at");
    if (hasLockToken && hasInvalidAt) return;

    await knex.schema.alterTable(TABLE, (table) => {
      if (!hasLockToken) table.uuid("lock_token").nullable();
      if (!hasInvalidAt) {
        table.timestamp("invalid_at", { useTz: true }).nullable();
      }
    });
  },
};
