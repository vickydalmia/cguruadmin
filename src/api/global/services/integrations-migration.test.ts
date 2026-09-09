import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import knexFactory, { type Knex } from 'knex';

const migration = require('../../../../database/migrations/2026.09.13T00.00.00.global-integrations.js');

describe('Global integrations migration', () => {
  let db: Knex;
  beforeEach(() => {
    db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    for (const name of ['PUBLIC_TELEGRAM_URL', 'PUBLIC_WHATSAPP_URL', 'SENDY_URL', 'SENDY_LIST_ID']) vi.stubEnv(name, '');
  });
  afterEach(async () => { await db.destroy(); vi.unstubAllEnvs(); });

  it('does nothing on a fresh database before schema sync', async () => {
    await migration.up(db);
    expect(await db.schema.hasTable('globals')).toBe(false);
  });

  it('preserves source destinations across languages before detaching footer entries', async () => {
    await db.schema.createTable('globals', (t) => { t.increments(); t.string('locale'); });
    await db('globals').insert([{ id: 1, locale: 'en' }, { id: 2, locale: 'ar' }]);
    for (const table of ['globals_cmps', 'footers_cmps']) {
      await db.schema.createTable(table, (t) => {
        t.increments(); t.integer('entity_id'); t.integer('cmp_id'); t.string('component_type'); t.string('field'); t.integer('order');
      });
    }
    await db.schema.createTable('components_shared_telegram_ctas', (t) => { t.increments(); t.string('cta_url'); });
    await db('components_shared_telegram_ctas').insert({ id: 1, cta_url: 'https://t.me/cms' });
    await db('globals_cmps').insert({ entity_id: 1, cmp_id: 1, component_type: 'shared.telegram-cta', field: 'telegramCta', order: 1 });
    await db.schema.createTable('footers', (t) => { t.increments(); t.string('locale'); });
    await db('footers').insert({ id: 1, locale: 'en' });
    await db.schema.createTable('components_footer_social_links', (t) => { t.increments(); t.string('platform'); t.string('url'); });
    await db('components_footer_social_links').insert([
      { id: 1, platform: 'telegram', url: 'https://t.me/footer' },
      { id: 2, platform: 'whatsapp', url: 'https://whatsapp.com/channel/cms' },
      { id: 3, platform: 'facebook', url: 'https://facebook.com/site' },
    ]);
    await db('footers_cmps').insert([1, 2, 3].map((id) => ({ entity_id: 1, cmp_id: id, component_type: 'footer.social-link', field: 'socialLinks', order: id })));
    vi.stubEnv('PUBLIC_TELEGRAM_URL', 'https://t.me/env');
    vi.stubEnv('SENDY_URL', 'https://newsletter.example.com');
    vi.stubEnv('SENDY_LIST_ID', 'list-one');
    vi.stubEnv('SENDY_API_KEY', 'never-copy-this');
    await migration.up(db);
    const rows = await db('globals').orderBy('id');
    for (const row of rows) {
      expect(row).toMatchObject({ telegram_url: 'https://t.me/cms', whatsapp_url: 'https://whatsapp.com/channel/cms', sendy_url: 'https://newsletter.example.com', sendy_list_id: 'list-one' });
      expect(JSON.stringify(row)).not.toContain('never-copy-this');
    }
    expect(await db('footers_cmps').pluck('cmp_id')).toEqual([3]);
    await db('globals').update({ telegram_url: 'https://t.me/edited' });
    await migration.up(db);
    expect(await db('globals').pluck('telegram_url')).toEqual(['https://t.me/edited', 'https://t.me/edited']);
  });

  it('uses environment then footer for Telegram and ignores placeholder URLs', () => {
    expect(migration.resolveValues({}, { telegram: '#', footerTelegram: 'https://t.me/footer' }, { PUBLIC_TELEGRAM_URL: 'https://t.me/env' }).telegram_url).toBe('https://t.me/env');
    expect(migration.resolveValues({}, { footerTelegram: 'https://t.me/footer' }, {}).telegram_url).toBe('https://t.me/footer');
    expect(migration.resolveValues({}, { whatsapp: '#' }, { PUBLIC_WHATSAPP_URL: 'https://whatsapp.com/channel/env' }).whatsapp_url).toBe('https://whatsapp.com/channel/env');
    expect(migration.resolveValues({}, {}, {})).toEqual({ telegram_url: null, whatsapp_url: null, sendy_url: null, sendy_list_id: null });
  });
});
