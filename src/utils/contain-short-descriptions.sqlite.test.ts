import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knexFactory, { type Knex } from 'knex';

import { cleanHtml } from './sanitize-richtext';

const migration = require('../../database/migrations/2026.09.12T00.00.00.contain-entity-short-descriptions.js');

// The exact shape the WordPress theme stored: two `<font size="2"><p>` openers,
// neither ever closed, with a heading in between.
const LEGACY =
  '<font size= "2"><p>DH Gate is a huge marketplace. <h2>Latest DH Gate Coupon Codes</h2><font size= "2"><p>All that you need to save money.';
const CONTAINED =
  '<p>DH Gate is a huge marketplace. </p><h2>Latest DH Gate Coupon Codes</h2><p>All that you need to save money.</p>';

describe('contain-entity-short-descriptions migration', () => {
  let knex: Knex;

  beforeEach(async () => {
    knex = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    for (const table of ['stores', 'brands', 'categories', 'banks']) {
      await knex.schema.createTable(table, (t) => {
        t.increments('id');
        t.string('locale');
        t.text('short_description');
      });
    }
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('runs on a fresh database before any content table exists', async () => {
    await knex.schema.dropTable('stores');
    await migration.up(knex);
  });

  it('closes what the import left open, in every table, locale and publication state', async () => {
    await knex('stores').insert([
      { locale: 'en', short_description: LEGACY },
      { locale: 'en', short_description: LEGACY },
      { locale: 'ar', short_description: '<font size="2"><p>نص' },
    ]);
    await knex('brands').insert({ locale: 'en', short_description: '<FONT size=2><p>Brand text' });
    await knex('categories').insert({ locale: 'en', short_description: LEGACY });
    await knex('banks').insert({ locale: 'en', short_description: LEGACY });

    await migration.up(knex);

    const stores = await knex('stores').orderBy('id');
    expect(stores.map((row) => row.short_description)).toEqual([CONTAINED, CONTAINED, '<p>نص</p>']);
    expect((await knex('brands').first()).short_description).toBe('<p>Brand text</p>');
    expect((await knex('categories').first()).short_description).toBe(CONTAINED);
    expect((await knex('banks').first()).short_description).toBe(CONTAINED);
  });

  it('leaves plain text, clean markup and empty values untouched', async () => {
    const clean = '<p><strong>Lazada</strong> is a leading marketplace&nbsp;in Singapore.</p>';
    await knex('stores').insert([
      { locale: 'en', short_description: 'Plain text with an ampersand & a < sign' },
      { locale: 'en', short_description: clean },
      { locale: 'en', short_description: null },
      { locale: 'en', short_description: '<font></font>' },
    ]);

    await migration.up(knex);

    const rows = await knex('stores').orderBy('id');
    expect(rows.map((row) => row.short_description)).toEqual([
      // No tag structure to repair, so the entity escaping a save would apply
      // (`&amp;`, `&lt;`) is not forced on it here.
      'Plain text with an ampersand & a < sign',
      // Balanced and allow-listed: byte-identical, `&nbsp;` included, so the
      // translation fingerprint of a clean row does not move.
      clean,
      null,
      // Sanitizes to nothing; the required field is left for an editor.
      '<font></font>',
    ]);
  });

  it('does not rewrite a row for an attribute-only difference', async () => {
    await knex('stores').insert({ locale: 'en', short_description: '<p onclick="x()">text</p>' });
    await migration.up(knex);
    expect((await knex('stores').first()).short_description).toBe('<p onclick="x()">text</p>');
  });

  it('is idempotent', async () => {
    await knex('stores').insert({ locale: 'en', short_description: LEGACY });
    await migration.up(knex);
    await migration.up(knex);
    expect((await knex('stores').first()).short_description).toBe(CONTAINED);
  });

  it('produces the same output as the write-time sanitizer', () => {
    // Links differ only by the rel classification the write pipeline adds.
    for (const probe of [LEGACY, '<p>a</p><script>x()</script>', '<p onclick="x()" class="c">b</p>']) {
      expect(migration.cleanHtml(probe)).toBe(cleanHtml(probe));
    }
  });
});
