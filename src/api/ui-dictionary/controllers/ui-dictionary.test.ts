import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledContentLocaleCodesSync: vi.fn((): readonly string[] => []),
  publicDictionary: vi.fn(async (locale: string) => ({
    locale,
    version: null,
    updatedAt: null,
    messages: {},
  })),
  syncCatalogue: vi.fn(),
  enqueueUiDictionaryJobs: vi.fn(async () => ({ enqueued: ['ar'] })),
  requestUiDictionarySweep: vi.fn(async () => ({ skipped: false, id: '1', eventKey: 'k' })),
  logTranslation: vi.fn(),
}));

vi.mock('../../../translation/locales/registry', () => ({
  enabledContentLocaleCodesSync: mocks.enabledContentLocaleCodesSync,
}));
vi.mock('../../../translation/ui-dictionary/store', () => ({
  UiDictionaryStore: vi.fn(function () {
    return {
      publicDictionary: mocks.publicDictionary,
      syncCatalogue: mocks.syncCatalogue,
    };
  }),
}));
vi.mock('../../../translation/ui-dictionary/enqueue', () => ({
  enqueueUiDictionaryJobs: mocks.enqueueUiDictionaryJobs,
}));
vi.mock('../../../translation/ui-dictionary/isr', () => ({
  requestUiDictionarySweep: mocks.requestUiDictionarySweep,
}));
vi.mock('../../../translation/outbox/log', () => ({
  logTranslation: mocks.logTranslation,
}));

import createController, { normaliseDictionaryLocale } from './ui-dictionary';

const strapi = {} as any;
const controller = createController({ strapi });

function context(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return {
    query: {},
    request: { body: undefined },
    status: 200,
    body: undefined as unknown,
    headers,
    set: (name: string, value: string) => {
      headers[name] = value;
    },
    ...overrides,
  } as any;
}

const VERSION = 'c'.repeat(64);
const validBody = { version: VERSION, entries: { 'common.viewAll': { text: 'View all' } } };

describe('normaliseDictionaryLocale', () => {
  it('maps unknown, disabled, absent and array locales onto en', () => {
    expect(normaliseDictionaryLocale('zz', ['ar'])).toBe('en');
    expect(normaliseDictionaryLocale('ar', [])).toBe('en');
    expect(normaliseDictionaryLocale(undefined, ['ar'])).toBe('en');
    expect(normaliseDictionaryLocale('en', ['ar'])).toBe('en');
    expect(normaliseDictionaryLocale(['hi', 'ar'], ['ar', 'hi'])).toBe('hi');
    expect(normaliseDictionaryLocale('ar', ['ar'])).toBe('ar');
  });
});

describe('ui-dictionary.find', () => {
  it('reads English for a locale that is not enabled and sets the public cache header', async () => {
    const ctx = context({ query: { locale: 'zz' } });
    await controller.find(ctx);
    expect(mocks.publicDictionary).toHaveBeenCalledWith('en');
    expect(ctx.headers['Cache-Control']).toBe('public, max-age=60');
    expect(ctx.body).toEqual({ data: { locale: 'en', version: null, updatedAt: null, messages: {} } });
  });

  it('reads the locale only when it is enabled on this deployment', async () => {
    await controller.find(context({ query: { locale: 'ar' } }));
    expect(mocks.publicDictionary).toHaveBeenLastCalledWith('en');
    mocks.enabledContentLocaleCodesSync.mockReturnValue(['ar']);
    await controller.find(context({ query: { locale: 'ar' } }));
    expect(mocks.publicDictionary).toHaveBeenLastCalledWith('ar');
  });
});

describe('ui-dictionary.syncCatalogue', () => {
  it('rejects a malformed body with 400 and the problem list before touching the store', async () => {
    const ctx = context({ request: { body: { version: 'nope', entries: {} } } });
    await controller.syncCatalogue(ctx);
    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: 'Invalid catalogue push' });
    expect((ctx.body as any).problems.length).toBeGreaterThan(0);
    expect(mocks.syncCatalogue).not.toHaveBeenCalled();
  });

  it('enqueues nothing and requests no sweep for an unchanged push', async () => {
    mocks.syncCatalogue.mockResolvedValueOnce({
      unchanged: true,
      added: 0,
      changed: 0,
      removed: 0,
      touchedKeys: [],
      version: VERSION,
    });
    const ctx = context({ request: { body: validBody } });
    await controller.syncCatalogue(ctx);
    expect(mocks.syncCatalogue).toHaveBeenCalledWith(validBody);
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
    expect(mocks.logTranslation).not.toHaveBeenCalled();
    expect(ctx.body).toEqual({
      data: { unchanged: true, added: 0, changed: 0, removed: 0, version: VERSION },
    });
    expect(ctx.headers['Cache-Control']).toBe('no-store');
  });

  it('enqueues dictionary jobs, requests one coalesced sweep and logs on change', async () => {
    mocks.syncCatalogue.mockResolvedValueOnce({
      unchanged: false,
      added: 1,
      changed: 2,
      removed: 0,
      touchedKeys: ['a.b', 'c.d', 'e.f'],
      version: VERSION,
    });
    const ctx = context({ request: { body: validBody } });
    await controller.syncCatalogue(ctx);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, { reason: 'catalogue sync' });
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledWith(strapi);
    expect(mocks.logTranslation).toHaveBeenCalledWith(
      strapi,
      'info',
      'ui-dictionary.catalogue_synced',
      expect.objectContaining({ added: 1, changed: 2, removed: 0, touched: 3, jobs: ['ar'], sweep: 'enqueued' }),
    );
    expect(ctx.body).toEqual({
      data: { unchanged: false, added: 1, changed: 2, removed: 0, version: VERSION },
    });
  });

  it('sweeps but does not enqueue translation for a removal-only change', async () => {
    mocks.syncCatalogue.mockResolvedValueOnce({
      unchanged: false,
      added: 0,
      changed: 0,
      removed: 3,
      touchedKeys: [],
      version: VERSION,
    });
    await controller.syncCatalogue(context({ request: { body: validBody } }));
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
  });
});
