import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledContentLocales: vi.fn(async () => [{ code: 'ar' }, { code: 'hi' }]),
  wakeTranslationOutbox: vi.fn(),
  insertTranslationJobsBulk: vi.fn(async () => undefined),
  enqueueUiDictionaryJobs: vi.fn(async (_strapi: unknown, input: { locales?: readonly string[] }) => ({
    enqueued: [...(input.locales ?? [])],
  })),
  pendingLeaves: vi.fn(async (_locale: string, _force: boolean) => [] as { text: string }[]),
  storeConstructed: vi.fn(),
  translationConfigFromEnv: vi.fn(() => ({
    inputCostPerMTok: 1,
    outputCostPerMTok: 2,
    chunkChars: 12_000,
  })),
}));

vi.mock('./locales/registry', () => ({ enabledContentLocales: mocks.enabledContentLocales }));
vi.mock('./outbox/runtime', () => ({ wakeTranslationOutbox: mocks.wakeTranslationOutbox }));
vi.mock('./outbox/store', () => ({ insertTranslationJobsBulk: mocks.insertTranslationJobsBulk }));
vi.mock('./ui-dictionary/enqueue', () => ({ enqueueUiDictionaryJobs: mocks.enqueueUiDictionaryJobs }));
vi.mock('./ui-dictionary/store', () => ({
  UiDictionaryStore: class {
    constructor() {
      mocks.storeConstructed();
    }
    pendingLeaves(locale: string, force: boolean) {
      return mocks.pendingLeaves(locale, force);
    }
  },
}));
vi.mock('./config', () => ({ translationConfigFromEnv: mocks.translationConfigFromEnv }));
vi.mock('./writer', () => ({ loadPopulatedEntry: vi.fn() }));
vi.mock('./field-map', () => ({ collectTranslatableLeaves: vi.fn(() => []) }));

import { enqueueTranslationBackfill, estimateTranslationBackfill } from './backfill';

// No localized content types: the content waves are empty and only the
// dictionary contributes — which is exactly what these tests pin.
const strapi = {
  contentTypes: {},
  db: { query: vi.fn(), transaction: vi.fn() },
} as any;

describe('enqueueTranslationBackfill — ui-dictionary', () => {
  it('enqueues the dictionary after the content waves, per locale, with force passed through', async () => {
    const result = await enqueueTranslationBackfill(strapi, { force: true });
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, {
      locales: ['ar', 'hi'],
      force: true,
      reason: 'backfill',
    });
    expect(result).toEqual({
      enqueued: 2,
      perUid: { 'ui-dictionary': 2 },
      locales: ['ar', 'hi'],
    });
    expect(mocks.wakeTranslationOutbox).toHaveBeenCalledTimes(1);
  });

  it('respects a locale subset and defaults force to false', async () => {
    const result = await enqueueTranslationBackfill(strapi, { locales: ['hi'] });
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, {
      locales: ['hi'],
      force: false,
      reason: 'backfill',
    });
    expect(result.perUid['ui-dictionary']).toBe(1);
  });

  it('leaves the dictionary out when `uids` names only content types', async () => {
    const result = await enqueueTranslationBackfill(strapi, { uids: ['api::store.store'] });
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
    expect(result.perUid).not.toHaveProperty('ui-dictionary');
  });

  it('can target the dictionary alone through `uids`', async () => {
    const result = await enqueueTranslationBackfill(strapi, { uids: ['ui-dictionary'] });
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledTimes(1);
    expect(result.perUid).toEqual({ 'ui-dictionary': 2 });
  });

  it('enqueues nothing when translation is off (no enabled locales)', async () => {
    mocks.enabledContentLocales.mockResolvedValueOnce([]);
    const result = await enqueueTranslationBackfill(strapi);
    expect(result).toEqual({ enqueued: 0, perUid: {}, locales: [] });
    expect(mocks.enqueueUiDictionaryJobs).not.toHaveBeenCalled();
  });
});

describe('estimateTranslationBackfill — ui-dictionary', () => {
  it('adds one line per locale holding the pending dictionary characters', async () => {
    // Locales are visited in order: ar, then hi.
    mocks.pendingLeaves
      .mockResolvedValueOnce([{ text: 'Copy code' }, { text: 'Home' }])
      .mockResolvedValueOnce([]);
    const result = await estimateTranslationBackfill(strapi);
    expect(mocks.pendingLeaves).toHaveBeenCalledWith('ar', false);
    expect(mocks.pendingLeaves).toHaveBeenCalledWith('hi', false);
    expect(result.locales).toEqual(['ar', 'hi']);
    expect(result.perUid['ui-dictionary']).toBe(2);
    expect(result.entries).toBe(1);
    expect(result.translatableChars).toBe(13);
    expect(result.estimatedCalls).toBe(2);
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.estimatedOutputTokens).toBeGreaterThan(0);
  });

  it('contributes zero when the catalogue has nothing pending', async () => {
    const result = await estimateTranslationBackfill(strapi);
    expect(result.perUid['ui-dictionary']).toBe(0);
    expect(result.entries).toBe(0);
    expect(result.translatableChars).toBe(0);
    expect(result.estimatedCalls).toBe(0);
    expect(result.estimatedUsd).toBe(0);
  });

  it('never opens the dictionary store when translation is off', async () => {
    mocks.enabledContentLocales.mockResolvedValueOnce([]);
    mocks.translationConfigFromEnv.mockReturnValueOnce(null as any);
    const result = await estimateTranslationBackfill(strapi);
    expect(mocks.storeConstructed).not.toHaveBeenCalled();
    expect(mocks.pendingLeaves).not.toHaveBeenCalled();
    expect(result.perUid).toEqual({});
    expect(result.translatableChars).toBe(0);
    expect(result.estimatedUsd).toBe(0);
  });

  it('skips the dictionary when `uids` names only content types', async () => {
    const result = await estimateTranslationBackfill(strapi, { uids: ['api::deal.deal'] });
    expect(mocks.storeConstructed).not.toHaveBeenCalled();
    expect(result.perUid).not.toHaveProperty('ui-dictionary');
  });
});
