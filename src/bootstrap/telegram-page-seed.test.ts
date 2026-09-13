import { describe, expect, it, vi } from 'vitest';
import { buildTelegramPageSeedData, ensureTelegramPageSeed, isTelegramPageEmpty } from './telegram-page-seed';
import seed from '../api/telegram-page/content/telegram-page-seed.json';

vi.mock('../telegram/worker-lease', () => ({ withTelegramLease: vi.fn(async (_s, _key, work) => work({ assertOwned: async () => {} })) }));

vi.mock('node:fs/promises', () => ({ default: { stat: vi.fn(async () => ({ size: 10 })) } }));
vi.mock('../utils/write-serialization', () => ({ acquireWriteSerializationLock: vi.fn(async () => undefined) }));

function harness(options: { existing?: any; stores?: Record<string, string> } = {}) {
  const created: any[] = [];
  const updated: any[] = [];
  const uploads: any[] = [];
  const markers = new Map<string, unknown>();
  const strapi = {
    dirs: { app: { root: '/app' } },
    store: vi.fn(() => ({
      get: vi.fn(async ({ key }: any) => markers.get(key) ?? null),
      set: vi.fn(async ({ key, value }: any) => { markers.set(key, value); }),
    })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    documents: vi.fn((uid: string) => {
      return {
        findFirst: vi.fn(async () => options.existing ?? null),
        create: vi.fn(async (input: any) => { created.push(input); return { documentId: 'tg' }; }),
        update: vi.fn(async (input: any) => { updated.push(input); return { documentId: 'tg' }; }),
      };
    }),
    db: {
      transaction: vi.fn(async (run: any) => run({ trx: {} })),
      query: vi.fn((uid: string) => ({
        findOne: vi.fn(async ({ where }: any) => {
          if (uid === 'plugin::upload.folder') return { id: 9 };
          if (uid === 'api::store.store') {
            const id = options.stores?.[where.name.$eqi];
            return id ? { id } : null;
          }
          return null;
        }),
      })),
    },
    plugin: vi.fn(() => ({
      service: vi.fn(() => ({
        upload: vi.fn(async (payload: any) => { uploads.push(payload); return [{ id: 100 + uploads.length }]; }),
        create: vi.fn(),
      })),
    })),
  } as any;
  return { strapi, created, updated, uploads, markers };
}

describe('telegram page seed', () => {
  it('does nothing when the page already carries content, and records its first-install marker', async () => {
    const { strapi, created, updated, uploads, markers } = harness({ existing: { documentId: 'tg', hero: { titleLead: 'Edited' } } });
    expect(await ensureTelegramPageSeed(strapi)).toBe(false);
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
    expect(uploads).toEqual([]);
    expect(markers.has('initial-content-v1')).toBe(true);
  });

  it('sets the marker after a real seed', async () => {
    const { strapi, markers } = harness();
    expect(await ensureTelegramPageSeed(strapi)).toBe(true);
    expect(markers.get('initial-content-v1')).toBe(true);
  });

  it('never runs again once the marker is set, even if the page was deleted', async () => {
    const { strapi, created, markers } = harness();
    markers.set('initial-content-v1', true);
    expect(await ensureTelegramPageSeed(strapi)).toBe(false);
    expect(created).toEqual([]);
  });

  it('fills an existing empty row (first save in Content Manager) without touching slug or enabled', async () => {
    const { strapi, created, updated } = harness({ existing: { documentId: 'tg', slug: 'my-telegram', enabled: true, hero: null, faq: { items: [] } } });
    expect(await ensureTelegramPageSeed(strapi)).toBe(true);
    expect(created).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0].documentId).toBe('tg');
    expect(updated[0].data.slug).toBeUndefined();
    expect(updated[0].data.enabled).toBeUndefined();
    expect(updated[0].data.hero.titleLead).toBe('Never Miss a');
    expect(updated[0].data.faq.items).toHaveLength(5);
  });

  it('treats only content-less rows as empty', () => {
    expect(isTelegramPageEmpty(null)).toBe(true);
    expect(isTelegramPageEmpty({ slug: 'x', enabled: true, hero: { titleLead: ' ' } })).toBe(true);
    expect(isTelegramPageEmpty({ benefits: { features: [{ label: 'a' }] } })).toBe(false);
    expect(isTelegramPageEmpty({ seo: { metaTitle: 'T' } })).toBe(false);
  });

  it('creates the page once with the design content, uploaded assets and matched stores', async () => {
    const { strapi, created, uploads } = harness({ stores: { Amazon: 11, Nykaa: 12 } as any });
    expect(await ensureTelegramPageSeed(strapi)).toBe(true);
    expect(created).toHaveLength(1);
    const data = created[0].data;
    expect(created[0].locale).toBe('en');
    expect(data.slug).toBe('join-telegram');
    expect(data.enabled).toBe(false);
    expect(data.hero.titleLead).toBe('Never Miss a');
    expect(data.hero.previewCards).toHaveLength(3);
    expect(data.hero.previewCards[0].icon).toBeNull();
    expect(typeof data.hero.previewCards[1].icon).toBe('number');
    expect(typeof data.benefits.phoneImage).toBe('number');
    expect(data.benefits.floatingCards.map((card: any) => typeof card.icon)).toEqual(['number', 'number', 'number']);
    expect(data.benefits.features).toHaveLength(6);
    expect(data.favouriteStores.stores).toEqual([11, 12]);
    expect(data.favouriteStores.storeNames).toBeUndefined();
    expect(data.faq.items).toHaveLength(5);
    expect(data._comment).toBeUndefined();
    expect(uploads.every((payload) => payload.data.fileInfo.folder === 9)).toBe(true);
    expect(uploads.map((payload) => payload.files[0].originalFilename)).toEqual([
      'emoji-bolt.png', 'emoji-target.png', 'phone-mockup.png', 'icon-tag.png', 'icon-gift.png', 'icon-percent.png',
    ]);
  });

  it('skips a missing asset instead of failing the boot', async () => {
    const fs = await import('node:fs/promises');
    (fs.default.stat as any).mockRejectedValueOnce(new Error('ENOENT'));
    const { strapi, created } = harness();
    await ensureTelegramPageSeed(strapi);
    expect(created).toHaveLength(1);
    expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('seed asset missing'));
  });

  it('never throws out of the boot path', async () => {
    const { strapi } = harness();
    strapi.db.transaction = vi.fn(async () => { throw new Error('db down'); });
    expect(await ensureTelegramPageSeed(strapi)).toBe(false);
    expect(strapi.log.error).toHaveBeenCalled();
  });

  it('keeps the seed file free of runtime-only keys', () => {
    expect((seed as any).favouriteStores.storeNames.length).toBeGreaterThan(3);
    expect((seed as any).hero.previewCards.every((card: any) => card.title)).toBe(true);
  });
});

describe('seed failures', () => {
  it('does not silently discard configured relations or complete the first install on failure', async () => {
    const { strapi, markers } = harness({ stores: { Amazon: 11 } as any });
    const create = vi.fn().mockRejectedValue(new Error('Invalid relations'));
    const documents = strapi.documents;
    strapi.documents = vi.fn((uid: string) => ({ ...documents(uid), create }));
    expect(await ensureTelegramPageSeed(strapi)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.favouriteStores.stores).toEqual([11]);
    expect(markers.has('initial-content-v1')).toBe(false);
  });
});

describe('buildTelegramPageSeedData', () => {
  it('reuses an already uploaded asset instead of uploading it again', async () => {
    const { strapi, uploads } = harness();
    strapi.db.query = vi.fn((uid: string) => ({
      findOne: vi.fn(async ({ where }: any) =>
        uid === 'plugin::upload.folder' ? { id: 9 } : uid === 'plugin::upload.file' && where.name === 'phone-mockup.png' ? { id: 42 } : null),
    }));
    const data: any = await buildTelegramPageSeedData(strapi);
    expect(data.benefits.phoneImage).toBe(42);
    expect(uploads.map((payload) => payload.files[0].originalFilename)).not.toContain('phone-mockup.png');
  });
});


it('uploads outside the identity transaction and preserves content authored during preparation', async () => {
  const options: any = {};
  const { strapi, created, updated } = harness(options);
  let inTransaction = false;
  strapi.db.transaction = async (work: any) => {
    inTransaction = true;
    try { return await work({ trx: {} }); } finally { inTransaction = false; }
  };
  strapi.plugin = () => ({ service: () => ({ upload: async () => {
    expect(inTransaction).toBe(false);
    options.existing = { documentId: 'edited', hero: { titleLead: 'Concurrent editor' } };
    return [{ id: 1 }];
  } }) });
  expect(await ensureTelegramPageSeed(strapi)).toBe(false);
  expect(created).toHaveLength(0);
  expect(updated).toHaveLength(0);
});
