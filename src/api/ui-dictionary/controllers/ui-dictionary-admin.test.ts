import { beforeEach, describe, expect, it, vi } from 'vitest';

const HASH = 'h'.repeat(64);

function row(key: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    text,
    description: null,
    maxLength: null,
    pluralOf: null,
    hash: HASH,
    overrideText: null,
    effectiveHash: HASH,
    overrideUpdatedBy: null,
    overrideUpdatedAt: null,
    firstSeenAt: null,
    lastSeenAt: null,
    removedAt: null,
    ...extra,
  };
}

const mocks = vi.hoisted(() => ({
  enabledContentLocales: vi.fn(async () => [
    { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' as const },
  ]),
  translationRuntimeActive: vi.fn(async () => true),
  activeJob: vi.fn(async () => ({ status: 'pending', attemptCount: 0, lastError: null })),
  readMeta: vi.fn(async () => ({ version: 'v1', pushedAt: '2026-09-01T00:00:00.000Z', counts: { total: 1, added: 1, changed: 0, removed: 0 } })),
  summary: vi.fn(async () => ({ catalogue: { total: 1, overridden: 0, removed: 0 }, locales: {} })),
  listEntries: vi.fn(async () => []),
  writeEnglishOverride: vi.fn(async (key: string, text: string | null) => ({
    key,
    overrideText: text,
    effectiveHash: 'x'.repeat(64),
    changed: true,
  })),
  writeManualTranslation: vi.fn(async (_l: string, key: string) => ({ key, sourceHash: HASH })),
  deleteTranslation: vi.fn(async () => true),
  importMessages: vi.fn(async () => ({ written: 1, skipped: [] })),
  exportMessages: vi.fn(async () => ({ 'common.viewAll': 'View all' })),
  loadLiveCatalogueRowsForKeys: vi.fn(async (_db: unknown, keys: string[]) => {
    const map = new Map<string, any>();
    for (const key of keys) {
      if (key === 'common.viewAll') map.set(key, row(key, 'View all'));
      if (key === 'offers.saving') map.set(key, row(key, 'Save {amount} today', { maxLength: 40 }));
    }
    return map;
  }),
  enqueueUiDictionaryJobs: vi.fn(async (_s: unknown, input: any) => ({
    enqueued: input.locales ?? ['ar'],
  })),
  requestUiDictionarySweep: vi.fn(async () => ({ skipped: false, id: '1', eventKey: 'k' })),
  purgeResponseCaches: vi.fn(),
}));

vi.mock('../../../translation/locales/registry', () => ({
  enabledContentLocales: mocks.enabledContentLocales,
}));
vi.mock('../../../translation/outbox/runtime', () => ({
  translationRuntimeActive: mocks.translationRuntimeActive,
  translationStore: () => ({ activeJob: mocks.activeJob }),
}));
vi.mock('../../../translation/ui-dictionary/store', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    UiDictionaryStore: vi.fn(function () {
      return {
        readMeta: mocks.readMeta,
        summary: mocks.summary,
        listEntries: mocks.listEntries,
        writeEnglishOverride: mocks.writeEnglishOverride,
        writeManualTranslation: mocks.writeManualTranslation,
        deleteTranslation: mocks.deleteTranslation,
        importMessages: mocks.importMessages,
        exportMessages: mocks.exportMessages,
      };
    }),
  };
});
vi.mock('../../../translation/ui-dictionary/store-queries', () => ({
  loadLiveCatalogueRowsForKeys: mocks.loadLiveCatalogueRowsForKeys,
}));
vi.mock('../../../translation/ui-dictionary/enqueue', () => ({
  enqueueUiDictionaryJobs: mocks.enqueueUiDictionaryJobs,
}));
vi.mock('../../../translation/ui-dictionary/isr', () => ({
  requestUiDictionarySweep: mocks.requestUiDictionarySweep,
}));
vi.mock('../../../middlewares/cache', () => ({
  purgeResponseCaches: mocks.purgeResponseCaches,
}));

import createController, {
  UI_DICTIONARY_ACTION,
  UI_DICTIONARY_ACTION_ATTRIBUTES,
} from './ui-dictionary-admin';

const strapi = { db: { connection: {} }, log: { warn: vi.fn() } } as any;
const controller = createController({ strapi });

function context(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return {
    query: {},
    params: {},
    request: { body: undefined },
    state: { user: { id: 7 } },
    status: 200,
    body: undefined as any,
    headers,
    set: (name: string, value: string) => {
      headers[name] = value;
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  mocks.enabledContentLocales.mockResolvedValue([
    { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' as const },
  ]);
  mocks.translationRuntimeActive.mockResolvedValue(true);
  mocks.deleteTranslation.mockResolvedValue(true);
  mocks.importMessages.mockResolvedValue({ written: 1, skipped: [] });
});

describe('RBAC action', () => {
  it('mirrors the translation action shape under its own uid', () => {
    expect(UI_DICTIONARY_ACTION).toBe('admin::ui-dictionary.manage');
    expect(UI_DICTIONARY_ACTION_ATTRIBUTES).toEqual({
      section: 'settings',
      displayName: 'Edit storefront UI text',
      uid: 'ui-dictionary.manage',
      pluginName: 'admin',
      category: 'content management',
      subCategory: 'translation',
    });
  });
});

describe('status', () => {
  it('lists English first, the catalogue meta, counts and per-locale job state', async () => {
    const ctx = context();
    await controller.status(ctx);
    expect(ctx.headers['Cache-Control']).toBe('private, no-store');
    expect(ctx.body.data).toEqual({
      translationActive: true,
      languages: [
        { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
        { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
      ],
      catalogue: expect.objectContaining({ version: 'v1' }),
      perLocale: { catalogue: { total: 1, overridden: 0, removed: 0 }, locales: {} },
      jobs: { ar: { status: 'pending', attemptCount: 0, lastError: null } },
    });
    expect(mocks.summary).toHaveBeenCalledWith(['ar']);
  });

  it('reports no jobs when translation is off and no locale is enabled', async () => {
    mocks.enabledContentLocales.mockResolvedValue([]);
    mocks.translationRuntimeActive.mockResolvedValue(false);
    const ctx = context();
    await controller.status(ctx);
    expect(ctx.body.data.languages).toHaveLength(1);
    expect(ctx.body.data.jobs).toBeNull();
    expect(mocks.activeJob).not.toHaveBeenCalled();
  });
});

describe('entries', () => {
  it('rejects a locale that is neither en nor enabled', async () => {
    const ctx = context({ query: { locale: 'hi' } });
    await controller.entries(ctx);
    expect(ctx.status).toBe(400);
    expect(ctx.body.error).toMatch(/locale must be one of: en, ar/);
    expect(mocks.listEntries).not.toHaveBeenCalled();
  });

  it('passes includeRemoved through for an allowed locale', async () => {
    const ctx = context({ query: { locale: 'ar', includeRemoved: '1' } });
    await controller.entries(ctx);
    expect(mocks.listEntries).toHaveBeenCalledWith('ar', { includeRemoved: true });
    expect(ctx.body).toEqual({ data: { locale: 'ar', entries: [] } });
  });
});

describe('upsertEntry', () => {
  it('404s an unknown key before writing', async () => {
    const ctx = context({ params: { locale: 'ar', key: 'nope.key' }, request: { body: { text: 'x' } } });
    await controller.upsertEntry(ctx);
    expect(ctx.status).toBe(404);
    expect(mocks.writeManualTranslation).not.toHaveBeenCalled();
  });

  it('rejects a translation that drops a placeholder, listing what is missing', async () => {
    const ctx = context({
      params: { locale: 'ar', key: 'offers.saving' },
      request: { body: { text: 'وفّر اليوم' } },
    });
    await controller.upsertEntry(ctx);
    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({
      error: expect.stringContaining('{amount}'),
      details: { missing: ['{amount}'] },
    });
    expect(mocks.writeManualTranslation).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
  });

  it('rejects text over the declared maxLength and empty text', async () => {
    const long = context({
      params: { locale: 'ar', key: 'offers.saving' },
      request: { body: { text: `{amount} ${'x'.repeat(60)}` } },
    });
    await controller.upsertEntry(long);
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/maxLength of 40/);

    const empty = context({ params: { locale: 'ar', key: 'offers.saving' }, request: { body: { text: '   ' } } });
    await controller.upsertEntry(empty);
    expect(empty.status).toBe(400);
  });

  it('writes an English override, enqueues re-translation and sweeps', async () => {
    const ctx = context({
      params: { locale: 'en', key: 'common.viewAll' },
      request: { body: { text: ' See everything ' } },
    });
    await controller.upsertEntry(ctx);
    expect(ctx.status).toBe(200);
    expect(mocks.writeEnglishOverride).toHaveBeenCalledWith('common.viewAll', 'See everything', 7);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, { reason: 'english override' });
    expect(mocks.purgeResponseCaches).toHaveBeenCalledWith(['/api/ui-dictionary']);
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledWith(strapi);
    expect(ctx.body.data).toEqual(
      expect.objectContaining({ locale: 'en', key: 'common.viewAll', changed: true, jobs: ['ar'] }),
    );
  });

  it('does not enqueue when the override left the effective English unchanged', async () => {
    mocks.writeEnglishOverride.mockResolvedValueOnce({
      key: 'common.viewAll',
      overrideText: null,
      effectiveHash: HASH,
      changed: false,
    });
    const ctx = context({
      params: { locale: 'en', key: 'common.viewAll' },
      request: { body: { text: 'View all' } },
    });
    await controller.upsertEntry(ctx);
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
  });

  it('writes a manual translation for a target locale without enqueueing', async () => {
    const ctx = context({
      params: { locale: 'ar', key: 'common.viewAll' },
      request: { body: { text: 'عرض الكل' } },
    });
    await controller.upsertEntry(ctx);
    expect(mocks.writeManualTranslation).toHaveBeenCalledWith('ar', 'common.viewAll', 'عرض الكل', 7);
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
    expect(mocks.purgeResponseCaches).toHaveBeenCalledTimes(1);
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
    expect(ctx.body).toEqual({ data: { locale: 'ar', key: 'common.viewAll', sourceHash: HASH } });
  });
});

describe('deleteEntry', () => {
  it('resets a translation to AI: delete, non-force job for that locale, purge, sweep', async () => {
    const ctx = context({ params: { locale: 'ar', key: 'common.viewAll' } });
    await controller.deleteEntry(ctx);
    expect(mocks.deleteTranslation).toHaveBeenCalledWith('ar', 'common.viewAll');
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, {
      locales: ['ar'],
      force: false,
      reason: 'reset to ai',
    });
    expect(mocks.purgeResponseCaches).toHaveBeenCalledWith(['/api/ui-dictionary']);
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
    expect(ctx.body.data).toEqual({ locale: 'ar', key: 'common.viewAll', deleted: true, jobs: ['ar'] });
  });

  it('is a no-op when there was no translation row', async () => {
    mocks.deleteTranslation.mockResolvedValueOnce(false);
    const ctx = context({ params: { locale: 'ar', key: 'common.viewAll' } });
    await controller.deleteEntry(ctx);
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
    expect(ctx.body.data.deleted).toBe(false);
  });

  it('clears an English override and re-translates', async () => {
    const ctx = context({ params: { locale: 'en', key: 'common.viewAll' } });
    await controller.deleteEntry(ctx);
    expect(mocks.writeEnglishOverride).toHaveBeenCalledWith('common.viewAll', null, 7);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, { reason: 'english override' });
    expect(ctx.body.data).toEqual({ locale: 'en', key: 'common.viewAll', cleared: true, jobs: ['ar'] });
  });
});

describe('importMessages', () => {
  it('validates the body shape', async () => {
    const ctx = context({ request: { body: { locale: 'ar', messages: ['x'] } } });
    await controller.importMessages(ctx);
    expect(ctx.status).toBe(400);
    expect(mocks.importMessages).not.toHaveBeenCalled();
  });

  it('screens placeholder losses per key and imports the rest', async () => {
    const ctx = context({
      request: {
        body: {
          locale: 'ar',
          messages: { 'offers.saving': 'وفّر اليوم', 'common.viewAll': ' عرض الكل ', 'zz.unknown': 'x' },
        },
      },
    });
    await controller.importMessages(ctx);
    expect(mocks.importMessages).toHaveBeenCalledWith(
      'ar',
      { 'common.viewAll': 'عرض الكل', 'zz.unknown': 'x' },
      7,
    );
    expect(ctx.body.data).toEqual({
      locale: 'ar',
      written: 1,
      skipped: [{ key: 'offers.saving', reason: 'missing placeholders: {amount}' }],
      jobs: [],
    });
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
  });

  it('enqueues re-translation after an English import that wrote something', async () => {
    const ctx = context({ request: { body: { locale: 'en', messages: { 'common.viewAll': 'See all' } } } });
    await controller.importMessages(ctx);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, { reason: 'english import' });
  });

  it('skips purge and sweep when nothing was written', async () => {
    mocks.importMessages.mockResolvedValueOnce({ written: 0, skipped: [{ key: 'a.b', reason: 'x' }] });
    const ctx = context({ request: { body: { locale: 'ar', messages: { 'a.b': 'c' } } } });
    await controller.importMessages(ctx);
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
    expect(ctx.body.data.skipped).toEqual([{ key: 'a.b', reason: 'x' }]);
  });
});

describe('exportMessages', () => {
  it('returns the locale and its messages', async () => {
    const ctx = context({ query: { locale: 'en' } });
    await controller.exportMessages(ctx);
    expect(ctx.body).toEqual({ data: { locale: 'en', messages: { 'common.viewAll': 'View all' } } });
  });
});

describe('translate', () => {
  it('409s while the translation runtime is inactive', async () => {
    mocks.translationRuntimeActive.mockResolvedValue(false);
    const ctx = context({ request: { body: {} } });
    await controller.translate(ctx);
    expect(ctx.status).toBe(409);
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
  });

  it('rejects English and unknown locales', async () => {
    const en = context({ request: { body: { locale: 'en' } } });
    await controller.translate(en);
    expect(en.status).toBe(400);
    const hi = context({ request: { body: { locale: 'hi' } } });
    await controller.translate(hi);
    expect(hi.status).toBe(400);
  });

  it('enqueues for one locale with force, or every locale without', async () => {
    const one = context({ request: { body: { locale: 'ar', force: true } } });
    await controller.translate(one);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenLastCalledWith(strapi, {
      locales: ['ar'],
      force: true,
      reason: 'manual trigger',
    });
    expect(one.body).toEqual({ data: { enqueued: ['ar'], force: true } });

    const all = context({ request: { body: {} } });
    await controller.translate(all);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenLastCalledWith(strapi, {
      locales: undefined,
      force: false,
      reason: 'manual trigger',
    });
  });
});
