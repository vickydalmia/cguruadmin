import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knexFactory, { type Knex } from 'knex';

import { TranslationOutboxStore } from './store';

const createIsr = require('../../../database/migrations/2026.07.24T00.00.00.create-isr-outbox.js');
const hardenIsr = require('../../../database/migrations/2026.07.25T00.00.00.harden-isr-outbox.js');
const receiptIsr = require('../../../database/migrations/2026.07.29T12.00.00.add-isr-delivery-receipt.js');
const createTranslation = require('../../../database/migrations/2026.08.30T00.00.00.create-translation-outbox.js');
const dependencyMigration = require('../../../database/migrations/2026.09.04T00.00.00.translation-dependencies-and-isr-coalescing.js');
const reliabilityMigration = require('../../../database/migrations/2026.09.05T00.00.00.translation-isr-reliability.js');
const performanceMigration = require('../../../database/migrations/2026.09.06T00.00.00.translation-backfill-performance.js');
const fingerprintMigration = require('../../../database/migrations/2026.09.07T00.00.00.shared-platform-reliability.js');

// The fingerprints are what make the next English edit incremental. A state
// write that only records publication (the success write) must not erase
// them, or every later edit re-translates the whole entry.
describe('translation state fingerprints on SQLite', () => {
  let knex: Knex;
  let store: TranslationOutboxStore;

  beforeEach(async () => {
    knex = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    for (const migration of [createIsr, hardenIsr, receiptIsr, createTranslation, dependencyMigration,
      reliabilityMigration, performanceMigration, fingerprintMigration]) {
      await migration.up(knex);
    }
    const strapi = { db: { connection: knex, transaction: (fn: any) => knex.transaction((trx) => fn({ trx })) } } as any;
    store = new TranslationOutboxStore(strapi, 60_000, 60_000);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  const base = {
    sourceHash: 'hash-1', needsReview: false, reviewNotes: null, lastError: null,
    translations: { name: 'المتجر', description: 'وصف' },
  };

  it('keeps the fingerprints through a write that omits them and clears them only on an explicit null', async () => {
    await store.upsertState('api::store.store', 'doc-1', 'ar', {
      ...base, leafSourceHashes: { name: 'f-name', description: 'f-desc' }, publishedPlanHash: null,
    });
    expect((await store.readState('api::store.store', 'doc-1', 'ar'))?.leafSourceHashes)
      .toEqual({ name: 'f-name', description: 'f-desc' });

    // The success write: publication recorded, fingerprints untouched.
    await store.upsertState('api::store.store', 'doc-1', 'ar', { ...base, publishedPlanHash: 'plan-1' });
    const published = await store.readState('api::store.store', 'doc-1', 'ar');
    expect(published?.publishedPlanHash).toBe('plan-1');
    expect(published?.leafSourceHashes).toEqual({ name: 'f-name', description: 'f-desc' });

    await store.upsertState('api::store.store', 'doc-1', 'ar', { ...base, leafSourceHashes: null });
    expect((await store.readState('api::store.store', 'doc-1', 'ar'))?.leafSourceHashes).toBeNull();
  });

  it('inserts a fresh row without fingerprints when none are given', async () => {
    await store.upsertState('api::store.store', 'doc-2', 'ar', { ...base, publishedPlanHash: 'plan-2' });
    const row = await store.readState('api::store.store', 'doc-2', 'ar');
    expect(row?.publishedPlanHash).toBe('plan-2');
    expect(row?.leafSourceHashes).toBeNull();
  });
});
