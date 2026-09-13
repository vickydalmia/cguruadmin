import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readTelegramRoute, telegramRouteMetadata } from './telegram-route';
import { validateTelegramPage } from '../../../utils/telegram-page-validation';
import { TELEGRAM_PAGE_UID } from '../../../constants/telegram';
import { validateTelegramRoutes } from './telegram-route-validation';
import { syncTelegramRedirects, telegramWriteScope } from './telegram-write';
import { createOutboxPayload } from '../../../isr-outbox/payload';
import { ensureTelegramPageSeed } from '../../../bootstrap/telegram-page-seed';
import { TELEGRAM_PAGE_POPULATE } from '../controllers/telegram-page-populate';
import { validateRedirect } from '../../../utils/redirect-validation';

// Real document/component/locale persistence in a disposable SQLite app.
// Never boots the repository app or connects to its configured database.
const integration = process.env.TELEGRAM_STRAPI_INTEGRATION === 'true' ? describe : describe.skip;
integration('Telegram Page document lifecycle', () => {
  let root: string;
  let strapi: any;
  const events: any[] = [];
  beforeAll(async () => {
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`Strapi startup exited ${code}`); });
    root = mkdtempSync(join(tmpdir(), 'cguru-telegram-strapi-'));
    const put = (file: string, value: unknown) => {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
    };
    const copy = (file: string) => put(file, readFileSync(join(process.cwd(), file), 'utf8'));
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
    put('package.json', { name: 'subscription-test', version: '1.0.0', dependencies: {} });
    put('config/database.js', `module.exports = { connection: { client: 'sqlite', connection: { filename: ${JSON.stringify(join(root, 'data.db'))} }, useNullAsDefault: true } };`);
    put('config/server.js', "module.exports = { host: '127.0.0.1', port: 0, app: { keys: ['isolated-subscription-test'] }, logger: { updates: { enabled: false } } };");
    put('config/admin.js', "module.exports = { auth: { secret: 'isolated-test-admin' }, apiToken: { salt: 'isolated-test-api' }, transfer: { token: { salt: 'isolated-test-transfer' } }, secrets: { encryptionKey: 'isolated-test-encryption' } };");
    put('config/plugins.js', "module.exports = { email: { enabled: false }, 'content-releases': { enabled: false }, 'review-workflows': { enabled: false } };");
    mkdirSync(join(root, 'public/uploads'), { recursive: true });
    copy('database/migrations/2026.09.13T00.00.00.telegram-durable-ingestion.js');
    copy('database/migrations/2026.09.13T01.00.00.telegram-photo-diagnostics.js');
    copy('src/api/subscription-page/content-types/subscription-page/schema.json');
    copy('src/api/telegram-page/content-types/telegram-page/schema.json');
    for (const file of readdirSync(join(process.cwd(), 'src/components/telegram'))) copy(`src/components/telegram/${file}`);
    for (const file of readdirSync(join(process.cwd(), 'seed/telegram-page'))) {
      const target = join(root, 'seed/telegram-page', file); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(process.cwd(), 'seed/telegram-page', file)));
    }
    copy('src/api/redirect/content-types/redirect/schema.json');
    for (const file of readdirSync(join(process.cwd(), 'src/components/subscription'))) copy(`src/components/subscription/${file}`);
    for (const file of ['shared/seo', 'shared/breadcrumb-item', 'shared/newsletter', 'home/popular-searches', 'home/faq-block', 'shared/faq-item']) copy(`src/components/${file}.json`);
    for (const kind of ['store', 'brand', 'category', 'bank']) {
      const plural = kind === 'category' ? 'categories' : `${kind}s`;
      put(`src/api/${kind}/content-types/${kind}/schema.json`, {
        kind: 'collectionType', collectionName: plural,
        info: { singularName: kind, pluralName: plural, displayName: kind },
        pluginOptions: { i18n: { localized: true } },
        attributes: {
          name: { type: 'string' }, slug: { type: 'string' }, logoAlt: { type: 'string' },
          logo: { type: 'media', multiple: false, allowedTypes: ['images'] },
        },
      });
    }
    const { createStrapi } = require('@strapi/strapi');
    strapi = createStrapi({ appDir: root, distDir: root });
    await strapi.load();
    await strapi.plugin('i18n').service('locales').create({ code: 'ar', name: 'Arabic (ar)' });
    strapi.documents.use(async (context: any, next: () => Promise<any>) => {
      if (context.uid === 'api::redirect.redirect') {
        await validateRedirect(strapi, context.uid, context.action, context.params.data, context.params.documentId, true);
      }
      if (context.uid !== TELEGRAM_PAGE_UID || !['create', 'update', 'delete'].includes(context.action)) return next();
      return strapi.db.transaction(async () => {
        const before = await readTelegramRoute(strapi);
        if (context.params.data) {
          await validateTelegramPage(strapi, context.params.data, context.params.locale);
          await validateTelegramRoutes(strapi, context.uid, context.params.data, context.params.documentId, context.params.locale);
        }
        const result = await next();
        const after = await readTelegramRoute(strapi);
        await syncTelegramRedirects(strapi, before, after);
        events.push(createOutboxPayload(telegramWriteScope(before, after)));
        return result;
      });
    });
  }, 90_000);
  afterAll(async () => {
    // Document event payloads are populated asynchronously after commit.
    await new Promise(resolve => setTimeout(resolve, 100));
    const listeners = vi.spyOn(process, 'removeAllListeners').mockReturnValue(process);
    try { if (strapi) await strapi.destroy(); } finally { listeners.mockRestore(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('seeds complete content once and persists rename, rename-back, locales and retirement', async () => {
    const pages = strapi.documents(TELEGRAM_PAGE_UID);
    expect(await ensureTelegramPageSeed(strapi)).toBe(true);
    const saved = await pages.findFirst({ locale: 'en', populate: TELEGRAM_PAGE_POPULATE });
    expect(saved.hero.previewCards).toHaveLength(3);
    expect(saved.benefits.phoneImage.url).toBeTruthy();
    expect(saved.newsletter.ctaLabel).toBe('Subscribe');
    expect(saved.breadcrumbItems).toHaveLength(2);
    expect(await telegramRouteMetadata(strapi, 'en')).toEqual([]);
    const documentId = saved.documentId;
    await pages.update({ documentId, locale: 'en', data: { enabled: true, slug: 'telegram-offers' } });
    expect((await telegramRouteMetadata(strapi, 'en'))[0].path).toBe('/telegram-offers/');
    await pages.update({ documentId, locale: 'en', data: { slug: 'channel-deals' } });
    let aliases = await strapi.documents('api::redirect.redirect').findMany({ filters: { active: true } });
    expect(aliases).toEqual(expect.arrayContaining([expect.objectContaining({ from: '/telegram-offers/', to: '/channel-deals/', statusCode: 301 })]));
    await pages.update({ documentId, locale: 'en', data: { slug: 'telegram-offers' } });
    aliases = await strapi.documents('api::redirect.redirect').findMany({ filters: { active: true } });
    expect(aliases).toEqual([expect.objectContaining({ from: '/channel-deals/', to: '/telegram-offers/' })]);
    await expect(pages.update({ documentId, locale: 'en', data: { slug: 'about-us' } })).rejects.toThrow();
    expect((await pages.findFirst({ locale: 'en' })).slug).toBe('telegram-offers');
    await pages.update({ documentId, locale: 'ar', data: { hero: { titleLead: 'Arabic headline' } } });
    expect((await telegramRouteMetadata(strapi, 'ar'))[0].path).toBe('/telegram-offers/');
    await pages.delete({ documentId, locale: 'ar' });
    expect(await telegramRouteMetadata(strapi, 'ar')).toEqual([]);
    expect((await telegramRouteMetadata(strapi, 'en'))[0].path).toBe('/telegram-offers/');
    await pages.update({ documentId, locale: 'en', data: { enabled: false, latestDeals: null, joinCta: null } });
    expect(await telegramRouteMetadata(strapi, 'en')).toEqual([]);
    expect(await strapi.documents('api::redirect.redirect').findMany({ filters: { active: true } })).toHaveLength(0);
    await strapi.documents('api::store.store').create({ locale: 'en', data: { name: 'Reclaimed alias', slug: 'channel-deals' } });
    await pages.update({ documentId, locale: 'en', data: { enabled: true } });
    expect((await telegramRouteMetadata(strapi, 'en'))[0].path).toBe('/telegram-offers/');
    expect(await strapi.documents('api::redirect.redirect').findMany({ filters: { from: '/channel-deals/', active: true } })).toHaveLength(0);
    await pages.delete({ documentId, locale: 'en' });
    expect(await ensureTelegramPageSeed(strapi)).toBe(false);
    expect(await pages.findFirst({ locale: 'en' })).toBeNull();
  }, 90_000);
});
