import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readSubscriptionRoute, SUBSCRIPTION_PAGE_UID, subscriptionRouteMetadata } from './subscription-route';
import { validateSubscriptionContent } from './subscription-validation';
import { validateSubscriptionRoutes } from './subscription-route-validation';
import { syncSubscriptionRedirects, subscriptionWriteScope } from './subscription-write';
import { createOutboxPayload } from '../../../isr-outbox/payload';
import { seedSubscriptionPage } from './seed-subscription-page';
import { SUBSCRIPTION_POPULATE } from '../controllers/subscription-populate';
import { validateRedirect } from '../../../utils/redirect-validation';

// Real document/component/locale persistence in a disposable SQLite app.
// Never boots the repository app or connects to its configured database.
const integration = process.env.SUBSCRIPTION_STRAPI_INTEGRATION === 'true' ? describe : describe.skip;
integration('Subscription Page document lifecycle', () => {
  let root: string;
  let strapi: any;
  const events: any[] = [];
  beforeAll(async () => {
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`Strapi startup exited ${code}`); });
    root = mkdtempSync(join(tmpdir(), 'cguru-subscription-strapi-'));
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
    copy('src/api/subscription-page/content-types/subscription-page/schema.json');
    copy('src/api/redirect/content-types/redirect/schema.json');
    for (const file of readdirSync(join(process.cwd(), 'src/components/subscription'))) copy(`src/components/subscription/${file}`);
    for (const file of ['shared/seo', 'shared/breadcrumb-item', 'home/popular-searches']) copy(`src/components/${file}.json`);
    for (const kind of ['store', 'brand', 'category', 'bank']) {
      const plural = kind === 'category' ? 'categories' : `${kind}s`;
      put(`src/api/${kind}/content-types/${kind}/schema.json`, {
        kind: 'collectionType', collectionName: plural,
        info: { singularName: kind, pluralName: plural, displayName: kind },
        pluginOptions: { i18n: { localized: true } },
        attributes: { name: { type: 'string' }, slug: { type: 'string' } },
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
      if (context.uid !== SUBSCRIPTION_PAGE_UID || !['create', 'update', 'delete'].includes(context.action)) return next();
      return strapi.db.transaction(async () => {
        const before = await readSubscriptionRoute(strapi);
        if (context.params.data) {
          await validateSubscriptionContent(strapi, context.params.data, context.params.locale);
          await validateSubscriptionRoutes(strapi, context.uid, context.params.data, context.params.documentId, context.params.locale);
        }
        const result = await next();
        const after = await readSubscriptionRoute(strapi);
        await syncSubscriptionRedirects(strapi, before, after);
        events.push(createOutboxPayload(subscriptionWriteScope(before, after)));
        return result;
      });
    });
  }, 90_000);
  afterAll(async () => {
    const listeners = vi.spyOn(process, 'removeAllListeners').mockReturnValue(process);
    try { if (strapi) await strapi.destroy(); } finally { listeners.mockRestore(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('persists defaults, content, locale availability, redirects and retirement atomically', async () => {
    const pages = strapi.documents(SUBSCRIPTION_PAGE_UID);
    await seedSubscriptionPage(strapi);
    const saved = await pages.findFirst({ locale: 'en', populate: SUBSCRIPTION_POPULATE });
    expect(saved.platforms.cards.map((card: any) => card.name)).toEqual(['Telegram', 'YouTube', 'Instagram', 'Facebook', 'Reddit', 'X (Twitter)']);
    expect(saved.platforms.cards[0].count).toBe('80K+');
    expect(saved.benefits.cards).toHaveLength(4);
    const documentId = saved.documentId;
    expect(await subscriptionRouteMetadata(strapi, 'en')).toEqual([]);
    await pages.update({ documentId, locale: 'en', data: { enabled: true, hero: { headingBefore: 'Join our community' }, platforms: null, joinCta: null, signup: { heading: 'Email', emailLabel: 'Email', emailPlaceholder: 'Email', ctaLabel: 'Subscribe' } } });
    await seedSubscriptionPage(strapi);
    expect((await pages.findFirst({ populate: { hero: true } })).hero.headingBefore).toBe('Join our community');
    expect(await subscriptionRouteMetadata(strapi, 'en')).toEqual([expect.objectContaining({ path: '/subscription/' })]);
    expect(await subscriptionRouteMetadata(strapi, 'ar')).toEqual([]);
    await pages.update({ documentId, locale: 'ar', data: { hero: { headingBefore: 'عروض موثوقة' } } });
    expect(await subscriptionRouteMetadata(strapi, 'ar')).toEqual([expect.objectContaining({ path: '/subscription/' })]);
    await pages.delete({ documentId, locale: 'ar' });
    expect(await subscriptionRouteMetadata(strapi, 'ar')).toEqual([]);
    expect(await subscriptionRouteMetadata(strapi, 'en')).toHaveLength(1);
    await expect(pages.update({ documentId, locale: 'en', data: { slug: 'search' } })).rejects.toThrow(/belongs/);
    expect((await readSubscriptionRoute(strapi))?.slug).toBe('subscription');
    await pages.update({ documentId, locale: 'en', data: { slug: 'join' } });
    expect(events.at(-1)).toMatchObject({ optionalPaths: ['/subscription/'] });
    expect(events.at(-1).paths).toContain('/join/');
    let redirects = await strapi.documents('api::redirect.redirect').findMany({});
    expect(redirects).toEqual([expect.objectContaining({ from: '/subscription/', to: '/join/', statusCode: 301, active: true })]);
    await pages.update({ documentId, locale: 'en', data: { slug: 'subscription' } });
    redirects = await strapi.documents('api::redirect.redirect').findMany({});
    expect(redirects.find((row: any) => row.from === '/subscription/').active).toBe(false);
    expect(redirects.find((row: any) => row.from === '/join/')).toMatchObject({ to: '/subscription/', active: true });
    await pages.update({ documentId, locale: 'en', data: { enabled: false } });
    expect(await subscriptionRouteMetadata(strapi, 'en')).toEqual([]);
    expect(await strapi.documents('api::redirect.redirect').findMany({ filters: { active: true } })).toEqual([]);
    await strapi.documents('api::store.store').create({ locale: 'en', data: { name: 'Reclaimed alias', slug: 'join' } });
    await pages.update({ documentId, locale: 'en', data: { enabled: true } });
    expect((await subscriptionRouteMetadata(strapi, 'en'))[0].path).toBe('/subscription/');
    expect(await strapi.documents('api::redirect.redirect').findMany({ filters: { from: '/join/', active: true } })).toHaveLength(0);
    await pages.delete({ documentId, locale: 'en' });
    await seedSubscriptionPage(strapi);
    expect(await readSubscriptionRoute(strapi)).toBeNull();
  });
});
