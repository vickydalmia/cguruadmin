import { loadSiteConfiguration, siteLanguages } from '../api/site-configuration/services/site-configuration';
import { invalidateCachedSiteConfiguration } from '../api/site-configuration/services/cached-configuration';
import { translationRuntimeActive } from './outbox/runtime';
import { runContentTransaction } from '../isr-outbox/transaction';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPopulatedEntry, loadPopulatedEntries, writeLocaleVersion } from './writer';
import { collectTranslatableLeaves } from './field-map';
import { validateTranslatedBatch } from './validate';
import { translationWriteContext } from './write-flag';
import { validateTextFieldsForWrite } from '../utils/text-field-validation';
import { validateContentManagerOfferStore } from '../utils/content-manager-offer-store-validation';
import { validateOfferFieldsForWrite } from '../utils/offer-field-validation';

// Explicit opt-in: boots a real Strapi in a throwaway app/database, never the
// repository's configured database or plugins/background workers.
const integration = process.env.TRANSLATION_STRAPI_INTEGRATION === 'true' ? describe : describe.skip;

integration('shared media inheritance through real Strapi documents', () => {
  let root: string;
  let strapi: any;
  const localized = { pluginOptions: { i18n: { localized: true } } };
  const uid = 'api::category.category';

  beforeAll(async () => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`Strapi test startup attempted process.exit(${code})`);
    });
    root = mkdtempSync(join(tmpdir(), 'cguru-translation-media-'));
    const put = (file: string, value: unknown) => {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
    };
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'database'));
    symlinkSync(join(process.cwd(), 'database/country-bootstrap.js'), join(root, 'database/country-bootstrap.js'));
    put('package.json', { name: 'translation-media-test', version: '1.0.0', dependencies: {} });
    const postgres = process.env.STRAPI_TRANSACTION_TEST_DATABASE_URL;
    put('config/database.js', postgres
      ? `module.exports = { connection: { client: 'postgres', connection: { connectionString: ${JSON.stringify(postgres)} }, pool: { min: 0, max: 5 } } };`
      : `module.exports = { connection: { client: 'sqlite', connection: { filename: ${JSON.stringify(join(root, 'data.db'))} }, useNullAsDefault: true } };`);
    put('config/server.js', "module.exports = { host: '127.0.0.1', port: 0, app: { keys: ['isolated-test-key'] }, logger: { updates: { enabled: false } } };");
    put('config/admin.js', "module.exports = { auth: { secret: 'isolated-test-admin-secret' }, apiToken: { salt: 'isolated-test-api-salt' }, transfer: { token: { salt: 'isolated-test-transfer-salt' } }, secrets: { encryptionKey: 'isolated-test-encryption-key' } };");
    put('config/plugins.js', "module.exports = { email: { enabled: false }, 'content-releases': { enabled: false }, 'review-workflows': { enabled: false } };");
    mkdirSync(join(root, 'public', 'uploads'), { recursive: true });
    put('src/api/category/content-types/category/schema.json', {
      kind: 'collectionType', collectionName: 'categories',
      info: { singularName: 'category', pluralName: 'categories', displayName: 'Category' },
      options: { draftAndPublish: true }, ...localized,
      attributes: {
        name: { type: 'string', required: true, ...localized },
        shortDescription: { type: 'text', required: true, ...localized },
        icon: { type: 'media', multiple: false, required: true },
        iconAlt: { type: 'string', required: true, ...localized },
        slug: { type: 'string' },
        seo: { type: 'component', component: 'shared.seo', ...localized },
      },
    });
    put('src/components/shared/seo.json', {
      collectionName: 'components_shared_seos', info: { displayName: 'SEO' },
      attributes: { metaTitle: { type: 'string' }, metaDescription: { type: 'text' } },
    });
    for (const [name, attributes] of Object.entries({
      store: { name: { type: 'string', ...localized } },
      brand: { name: { type: 'string', ...localized } },
      coupon: {
        title: { type: 'string', ...localized },
        stores: { type: 'relation', relation: 'manyToMany', target: 'api::store.store' },
        brands: { type: 'relation', relation: 'manyToMany', target: 'api::brand.brand' },
      },
      deal: {
        title: { type: 'string', ...localized },
        discount: { type: 'string' },
        discountPrefix: { type: 'enumeration', enum: ['flat', 'upTo'] },
        stores: { type: 'relation', relation: 'manyToMany', target: 'api::store.store' },
        brands: { type: 'relation', relation: 'manyToMany', target: 'api::brand.brand' },
      },
    })) {
      put(`src/api/${name}/content-types/${name}/schema.json`, {
        kind: 'collectionType', collectionName: `${name}s`,
        info: { singularName: name, pluralName: `${name}s`, displayName: name },
        options: { draftAndPublish: true }, ...localized, attributes,
      });
    }
    put('src/api/homepage/content-types/homepage/schema.json', {
      kind: 'singleType', collectionName: 'homepages',
      info: { singularName: 'homepage', pluralName: 'homepages', displayName: 'Homepage' },
      options: { draftAndPublish: true }, ...localized,
      attributes: { hero: { type: 'component', component: 'home.hero-section', ...localized } },
    });
    put('src/components/home/hero-section.json', {
      collectionName: 'components_home_hero_sections', info: { displayName: 'Hero' },
      attributes: { products: { type: 'component', repeatable: true, component: 'home.hero-product' } },
    });
    put('src/components/home/hero-product.json', require('../components/home/hero-product.json'));
    put('src/api/site-configuration/content-types/site-configuration/schema.json',
      require('../api/site-configuration/content-types/site-configuration/schema.json'));
    put('src/api/menu/content-types/menu/schema.json', {
      kind: 'singleType', collectionName: 'menus',
      info: { singularName: 'menu', pluralName: 'menus', displayName: 'Menu' },
      options: { draftAndPublish: false }, ...localized,
      attributes: { title: { type: 'string', ...localized } },
    });
    const { createStrapi } = require('@strapi/strapi');
    strapi = createStrapi({ appDir: root, distDir: root });
    await strapi.load();
    await strapi.plugin('i18n').service('locales').create({ code: 'ar', name: 'Arabic (ar)' });
    // Exercise the real required-field validator with the same source/plan
    // overlay as runWriteValidation, then let Strapi inherit/persist media.
    strapi.documents.use(async (context: any, next: () => Promise<any>) => {
      const translation = translationWriteContext();
      if (context.uid === uid && context.action === 'update' && translation) {
        await validateTextFieldsForWrite(strapi, uid,
          translation.targetRowExisted ? 'update' : 'create',
          { ...translation.sourceEntry, ...context.params.data },
          context.params.documentId, true, context.params.locale);
      }
      if (context.action === 'update' && translation
        && ['api::coupon.coupon', 'api::deal.deal'].includes(context.uid)) {
        const action = translation.targetRowExisted ? 'update' : 'create';
        const effective = { ...translation.sourceEntry, ...context.params.data };
        await validateContentManagerOfferStore(strapi, context.uid, action, effective,
          context.params.documentId, true, translation.sourceEntry, context.params.locale);
        await validateOfferFieldsForWrite(strapi, context.uid, action, effective,
          context.params.documentId, true, context.params.locale, translation.sourceEntry);
      }
      return next();
    });
  }, 90_000);

  afterAll(async () => {
    // Strapi removes ALL process listeners on shutdown, including Vitest's
    // IPC listener. Keep the test runner alive while still closing Strapi's DB.
    const removeListeners = vi.spyOn(process, 'removeAllListeners').mockReturnValue(process);
    try {
      if (strapi) await strapi.destroy();
    } finally {
      removeListeners.mockRestore();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('opens and persists explicit Country Setup on fresh USA and UAE installations', async () => {
    const api = strapi.documents('api::site-configuration.site-configuration');
    for (const [countryCode, countryName, currencyCode, timezone] of [
      ['US', 'United States', 'USD', 'America/New_York'],
      ['AE', 'United Arab Emirates', 'AED', 'Asia/Dubai'],
    ]) {
      vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', countryCode);
      vi.stubEnv('COUNTRY_SETUP_BOOTSTRAP_JSON', JSON.stringify({ siteName: 'New site',
        countryCode, countryName, currencyCode, timezone, locale: `en-${countryCode}` }));
      try {
        const initial = await loadSiteConfiguration(strapi);
        expect(initial).toMatchObject({ countryCode, onboardingComplete: false, translationEnabled: false, storesEnabled: false });
        const saved = await api.create({ data: initial });
        expect(saved.configurationRevision).toBe(0);
        expect((await loadSiteConfiguration(strapi)).documentId).toBe(saved.documentId);
        await api.delete({ documentId: saved.documentId });
      } finally { vi.unstubAllEnvs(); invalidateCachedSiteConfiguration(); }
    }
    if (process.env.STRAPI_TRANSACTION_TEST_DATABASE_URL) {
      const column = await strapi.db.connection('information_schema.columns').where({ table_schema: 'public',
        table_name: 'site_configurations', column_name: 'configuration_revision' }).first();
      expect(column.is_nullable).toBe('NO');
      expect(column.column_default).toBe('0');
    }
  });

  it.skipIf(!process.env.STRAPI_TRANSACTION_TEST_DATABASE_URL)('restores a legacy English single type to real Strapi document reads', async () => {
    const menu = await strapi.documents('api::menu.menu').create({ locale: 'en', data: { title: 'Existing menu' } });
    await strapi.db.connection('menus').where({ id: menu.id }).update({ locale: null });
    expect(await strapi.documents('api::menu.menu').findFirst({ locale: 'en' })).toBeNull();
    await require('../../database/migrations/2026.09.08T00.00.00.preserve-legacy-english-content.js').up(strapi.db.connection);
    const restored = await strapi.documents('api::menu.menu').findFirst({ locale: 'en' });
    expect(restored).toMatchObject({ id: menu.id, documentId: menu.documentId, title: 'Existing menu', locale: 'en' });
  });

  it('commits nested content/outbox writes atomically and never replays delayed callbacks', async () => {
    const db = strapi.db.connection;
    for (const file of [
      '2026.07.24T00.00.00.create-isr-outbox.js',
      '2026.07.25T00.00.00.harden-isr-outbox.js',
      '2026.07.29T12.00.00.add-isr-delivery-receipt.js',
      '2026.09.05T00.00.00.translation-isr-reliability.js',
    ]) await require(`../../database/migrations/${file}`).up(db);
    const effects = vi.fn();
    const write = (name: string) => runContentTransaction(
      strapi,
      () => strapi.documents('api::store.store').create({ data: { name }, locale: 'en' }),
      async () => ({ reason: name, payload: { paths: [`/${name}/`] } }),
      effects,
    );
    await expect(strapi.db.transaction(async () => {
      await write('rollback-store');
      expect(effects).not.toHaveBeenCalled();
      throw new Error('abort outer');
    })).rejects.toThrow('abort outer');
    expect(await db('isr_outbox').where({ reason: 'rollback-store' })).toHaveLength(0);
    expect(await db('stores').where({ name: 'rollback-store' })).toHaveLength(0);
    expect(effects).not.toHaveBeenCalled();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delayed!: Promise<void>;
    await strapi.db.transaction(async () => {
      await write('committed-store');
      delayed = (async () => { await gate; await write('delayed-store'); })();
      expect(effects).not.toHaveBeenCalled();
    });
    expect(effects).toHaveBeenCalledTimes(1);
    release();
    await delayed;
    expect(effects).toHaveBeenCalledTimes(2);
    expect(await db('isr_outbox').where({ reason: 'committed-store' })).toHaveLength(1);
    expect(await db('stores').where({ name: 'committed-store' })).toHaveLength(1);
  });

  it('creates Arabic with the shared English icon and rejects an unloaded icon', async () => {
    const icon = await strapi.db.query('plugin::upload.file').create({ data: {
      name: 'exclusive-coupons.jpg', hash: 'exclusive-test', ext: '.jpg',
      mime: 'image/jpeg', size: 1, url: '/uploads/exclusive-test.jpg', provider: 'local',
    } });
    const english = await strapi.documents(uid).create({ locale: 'en', status: 'published', data: {
      name: 'Exclusive', shortDescription: 'Exclusive offers', icon: icon.id,
      iconAlt: 'Exclusive coupons', slug: 'exclusive',
      seo: { metaTitle: 'Exclusive', metaDescription: 'Exclusive coupons' },
    } });
    const source = await loadPopulatedEntry(strapi, uid, english.documentId, 'en');
    expect(source.icon.id).toBe(icon.id);
    const translations = new Map([
      ['name', 'حصري'], ['shortDescription', 'عروض حصرية'], ['iconAlt', 'كوبونات حصرية'],
      ['seo.metaTitle', 'حصري'], ['seo.metaDescription', 'كوبونات حصرية'],
    ]);
    await expect(writeLocaleVersion(strapi, uid, english.documentId, 'ar', {
      ...source, icon: undefined,
    }, translations)).rejects.toThrow('Icon is required');
    await writeLocaleVersion(strapi, uid, english.documentId, 'ar', source, translations);
    await strapi.documents(uid).publish({ documentId: english.documentId, locale: 'ar' });
    const arabic = await strapi.documents(uid).findOne({
      documentId: english.documentId, locale: 'ar', status: 'published', populate: { icon: true },
    });
    expect(arabic.name).toBe('حصري');
    expect(arabic.icon.id).toBe(icon.id);
    const unchanged = await loadPopulatedEntry(strapi, uid, english.documentId, 'en');
    expect(unchanged.name).toBe('Exclusive');
    expect(unchanged.icon.id).toBe(icon.id);
  });

  it('persists both stores using Arabic relation rows without changing English', async () => {
    const stores = [];
    for (const name of ['Jumbo', 'Eureka']) {
      const store = await strapi.documents('api::store.store').create({
        locale: 'en', status: 'published', data: { name },
      });
      await strapi.documents('api::store.store').update({
        documentId: store.documentId, locale: 'ar', data: { name },
      });
      await strapi.documents('api::store.store').publish({ documentId: store.documentId, locale: 'ar' });
      stores.push({ documentId: store.documentId });
    }
    const couponUid = 'api::coupon.coupon';
    const english = await strapi.documents(couponUid).create({
      locale: 'en', status: 'published', data: { title: 'Legacy offer', stores: { set: stores } },
    });
    const source = await loadPopulatedEntry(strapi, couponUid, english.documentId, 'en');
    await writeLocaleVersion(strapi, couponUid, english.documentId, 'ar', source,
      new Map([['title', 'عرض خاص']]));
    await strapi.documents(couponUid).publish({ documentId: english.documentId, locale: 'ar' });
    const arabic = await loadPopulatedEntry(strapi, couponUid, english.documentId, 'ar');
    expect(arabic.stores.map((store: any) => store.documentId)).toEqual(stores.map((store) => store.documentId));
    expect(arabic.stores.every((store: any) => store.locale === 'ar')).toBe(true);
    expect((await loadPopulatedEntry(strapi, couponUid, english.documentId, 'en')).title).toBe('Legacy offer');
  });

  it.each(['36% OFF', '20% Bank Discount', '40%'])('inherits legacy discount %s on Arabic creation', async (discount) => {
    const dealUid = 'api::deal.deal';
    const english = await strapi.documents(dealUid).create({
      locale: 'en', status: 'published', data: { title: 'Legacy product', discount, discountPrefix: null },
    });
    const source = await loadPopulatedEntry(strapi, dealUid, english.documentId, 'en');
    await writeLocaleVersion(strapi, dealUid, english.documentId, 'ar', source,
      new Map([['title', 'منتج خاص']]));
    await strapi.documents(dealUid).publish({ documentId: english.documentId, locale: 'ar' });
    expect(await loadPopulatedEntry(strapi, dealUid, english.documentId, 'ar')).toMatchObject({
      title: 'منتج خاص', discount, discountPrefix: null,
    });
  });

  it('loads hero store/brand identity through both document and backfill readers', async () => {
    const store = await strapi.documents('api::store.store').create({
      locale: 'en', status: 'published', data: { name: 'Sun And Sand Sports' },
    });
    const brand = await strapi.documents('api::brand.brand').create({
      locale: 'en', status: 'published', data: { name: 'Ninja Kitchen' },
    });
    const coupon = await strapi.documents('api::coupon.coupon').create({
      locale: 'en', status: 'published', data: {
        title: 'Sports offer', stores: { set: [{ documentId: store.documentId }] },
      },
    });
    const deal = await strapi.documents('api::deal.deal').create({
      locale: 'en', status: 'published', data: {
        title: 'Kitchen product', brands: { set: [{ documentId: brand.documentId }] },
      },
    });
    const homepageUid = 'api::homepage.homepage';
    const homepage = await strapi.documents(homepageUid).create({
      locale: 'en', status: 'published', data: { hero: { products: [
        { entityType: 'coupon', coupon: { documentId: coupon.documentId }, titleOverride: store.name },
        { entityType: 'deal', deal: { documentId: deal.documentId }, titleOverride: brand.name },
      ] } },
    });
    const sources = [
      await loadPopulatedEntry(strapi, homepageUid, homepage.documentId, 'en'),
      ...await loadPopulatedEntries(strapi, homepageUid, [homepage.documentId], 'en'),
    ];
    expect(sources.length).toBeGreaterThan(1);
    for (const source of sources) {
      const leaves = collectTranslatableLeaves(strapi, homepageUid, source);
      expect(leaves.map((leaf) => leaf.linkedOfferName)).toEqual([store.name, brand.name]);
      expect(validateTranslatedBatch(leaves,
        Object.fromEntries(leaves.map((leaf) => [leaf.path, leaf.value])), /\p{Script=Arabic}/u))
        .toEqual([]);
    }
  });
  it.each([
    ['IN', 'India', 'INR', false, ''],
    ['US', 'United States', 'USD', false, ''],
    ['AE', 'United Arab Emirates', 'AED', false, ''],
    ['AE', 'United Arab Emirates', 'AED', true, 'ar'],
    ['IN', 'India', 'INR', true, 'hi'],
  ] as const)('persists %s (%s, %s; enabled=%s; locale=%s)', async (countryCode, countryName, currencyCode, translationEnabled, translationLocales) => {
    vi.stubEnv('DEPLOYMENT_COUNTRY_CODE', countryCode);
    vi.stubEnv('TRANSLATION_OUTBOX_DISPATCHER_ENABLED', 'false');
    try {
      const api = strapi.documents('api::site-configuration.site-configuration');
      const existing = await api.findFirst();
      if (existing) await api.delete({ documentId: existing.documentId });
      await api.create({ data: { countryCode, countryName, currencyCode, locale: `en-${countryCode}`,
        translationEnabled, translationLocales } });
      invalidateCachedSiteConfiguration();
      const { checkDatabaseCountry } = require('../../deploy/scripts/check-country.cjs');
      await checkDatabaseCountry(strapi.db.connection, countryCode);
      await expect(checkDatabaseCountry(strapi.db.connection, countryCode === 'IN' ? 'AE' : 'IN')).rejects.toThrow('does not match');
      const configuration = await loadSiteConfiguration(strapi);
      expect(configuration.countryCode).toBe(countryCode);
      expect(configuration.currencyCode).toBe(currencyCode);
      expect(siteLanguages(configuration).map((language) => language.code))
        .toEqual(translationEnabled ? ['en', translationLocales] : ['en']);
      // Admins must still enqueue work when a separate maintenance process owns dispatch.
      expect(await translationRuntimeActive(strapi)).toBe(translationEnabled);
    } finally {
      vi.unstubAllEnvs();
      invalidateCachedSiteConfiguration();
    }
  });

});
