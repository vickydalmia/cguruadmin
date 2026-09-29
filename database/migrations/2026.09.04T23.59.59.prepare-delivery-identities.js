'use strict';

// Prepare large legacy outboxes before the immutable 09.05 migration. Its
// row-by-row compatibility fallback then has no remaining rows to process.
module.exports = {
  async up(trx) {
    if (!['pg', 'postgres', 'postgresql'].includes(trx.client.config.client) || !await trx.schema.hasTable('isr_outbox')) return;
    await trx.raw("SET LOCAL lock_timeout = '15s'");
    if (!await trx.schema.hasColumn('isr_outbox', 'delivery_key')) {
      await trx.schema.alterTable('isr_outbox', (table) => table.uuid('delivery_key').nullable());
    }
    await trx.raw('UPDATE isr_outbox SET delivery_key = gen_random_uuid() WHERE delivery_key IS NULL');
  },
};
