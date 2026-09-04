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
  readState: vi.fn(),
  activeJob: vi.fn(),
  loadPopulatedEntry: vi.fn(),
  inspectLocaleVersion: vi.fn(),
  collectTranslatableLeaves: vi.fn(() => []),
}));

vi.mock('./locales/registry', () => ({ enabledContentLocales: mocks.enabledContentLocales }));
vi.mock('./outbox/runtime', () => ({
  wakeTranslationOutbox: mocks.wakeTranslationOutbox,
  translationStore: vi.fn(() => ({
    readState: mocks.readState,
    activeJob: mocks.activeJob,
  })),
}));
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
vi.mock('./writer', () => ({
  loadPopulatedEntry: mocks.loadPopulatedEntry,
  inspectLocaleVersion: mocks.inspectLocaleVersion,
}));
vi.mock('./field-map', () => ({ collectTranslatableLeaves: mocks.collectTranslatableLeaves }));
vi.mock('./source-hash', () => ({ sourceContentHash: vi.fn(() => 'hash') }));
vi.mock('./prompts', () => ({ translationPromptFingerprint: vi.fn(() => 'prompt') }));

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
      selected: 2,
      enqueued: 2,
      skippedCurrent: 0,
      skippedIneligible: 0,
      providerCallsExpected: 0,
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

  it('passes a consistency reason through every backfill wave', async () => {
    await enqueueTranslationBackfill(strapi, { reason: 'nightly consistency' });
    expect(mocks.enqueueUiDictionaryJobs).toHaveBeenCalledWith(strapi, {
      locales: ['ar', 'hi'],
      force: false,
      reason: 'nightly consistency',
    });
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
    expect(result).toEqual({
      selected: 0,
      enqueued: 0,
      skippedCurrent: 0,
      skippedIneligible: 0,
      providerCallsExpected: 0,
      perUid: {},
      locales: [],
    });
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
    expect(result.providerCallsExpected).toBe(2);
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.estimatedOutputTokens).toBeGreaterThan(0);
  });

  it('contributes zero when the catalogue has nothing pending', async () => {
    const result = await estimateTranslationBackfill(strapi);
    expect(result.perUid['ui-dictionary']).toBe(2);
    expect(result.selected).toBe(2);
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

describe('repair selection', () => {
  it('does not enqueue or estimate provider calls for expired offers', async () => {
    const query = vi.fn(() => ({
      findMany: vi.fn(async () => [{ id: 1, documentId: 'expired-coupon' }]),
    }));
    const expiredStrapi = {
      contentTypes: {
        'api::coupon.coupon': { pluginOptions: { i18n: { localized: true } } },
      },
      db: {
        query,
        transaction: vi.fn(async (callback) => callback({ trx: {} })),
      },
    } as any;
    mocks.loadPopulatedEntry.mockResolvedValueOnce({
      documentId: 'expired-coupon',
      contentStatus: 'expired',
      title: 'Old coupon',
    });
    mocks.collectTranslatableLeaves.mockClear();
    mocks.readState.mockClear();
    mocks.insertTranslationJobsBulk.mockClear();

    const result = await enqueueTranslationBackfill(expiredStrapi, {
      mode: 'repair',
      uids: ['api::coupon.coupon'],
      locales: ['ar'],
    });

    expect(result).toMatchObject({
      selected: 0,
      enqueued: 0,
      skippedIneligible: 1,
      providerCallsExpected: 0,
    });
    expect(mocks.collectTranslatableLeaves).not.toHaveBeenCalled();
    expect(mocks.readState).not.toHaveBeenCalled();
    expect(mocks.insertTranslationJobsBulk).not.toHaveBeenCalled();
  });

  it('separates current entries from provider-backed repairs', async () => {
    const query = vi.fn(() => ({
      findMany: vi.fn(async () => [
        { id: 1, documentId: 'current' },
        { id: 2, documentId: 'missing' },
      ]),
    }));
    const repairStrapi = {
      contentTypes: {
        'api::store.store': { pluginOptions: { i18n: { localized: true } } },
      },
      db: {
        query,
        transaction: vi.fn(async (callback) => callback({ trx: {} })),
      },
    } as any;
    mocks.loadPopulatedEntry.mockImplementation(async (_s, _u, documentId) => ({
      documentId,
      name: documentId,
    }));
    mocks.collectTranslatableLeaves.mockImplementation((_s, _u, source) => [
      { path: 'name', kind: 'plain', value: source.name },
    ]);
    mocks.readState.mockImplementation(async (_u, documentId) =>
      documentId === 'current'
        ? { sourceHash: 'hash', translations: { name: 'حالي' } }
        : null,
    );
    mocks.activeJob.mockResolvedValue(null);
    mocks.inspectLocaleVersion.mockResolvedValue({ current: true, skippedRelations: [] });
    mocks.insertTranslationJobsBulk.mockClear();

    const result = await enqueueTranslationBackfill(repairStrapi, {
      mode: 'repair',
      uids: ['api::store.store'],
      locales: ['ar'],
    });

    expect(result).toMatchObject({
      selected: 1,
      skippedCurrent: 1,
      providerCallsExpected: 2,
      enqueued: 1,
      perUid: { 'api::store.store': 1 },
    });
    expect(mocks.insertTranslationJobsBulk).toHaveBeenCalledWith({}, [
      expect.objectContaining({ documentId: 'missing', kind: 'translate' }),
    ]);
  });

  it('skips the plan inspection in mode "all" and selects every entry', async () => {
    const query = vi.fn(() => ({
      findMany: vi.fn(async () => [{ id: 1, documentId: 'current' }]),
    }));
    const allStrapi = {
      contentTypes: {
        'api::store.store': { pluginOptions: { i18n: { localized: true } } },
      },
      db: { query, transaction: vi.fn(async (callback) => callback({ trx: {} })) },
    } as any;
    mocks.loadPopulatedEntry.mockResolvedValue({ documentId: 'current', name: 'x' });
    mocks.collectTranslatableLeaves.mockReturnValue([{ path: 'name', kind: 'plain', value: 'x' }]);
    mocks.readState.mockResolvedValue({ sourceHash: 'hash', translations: { name: 'حالي' } });
    mocks.activeJob.mockResolvedValue(null);
    mocks.inspectLocaleVersion.mockClear();

    const result = await enqueueTranslationBackfill(allStrapi, {
      mode: 'all',
      uids: ['api::store.store'],
      locales: ['ar'],
    });

    // Hash-current memory rebuilds without a provider call; the inspection
    // is repair-only because it is the expensive half of the scan.
    expect(mocks.inspectLocaleVersion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ selected: 1, skippedCurrent: 0, providerCallsExpected: 0 });
  });

  it('commits the enqueue per page in bounded transactions, never one for the whole catalogue', async () => {
    // 1,200 documents in two pages of 1,000 + 200 → three transactions of at
    // most 500 inputs each for the first page, one for the second. One
    // transaction for everything would hold an advisory lock per document and
    // exhaust Postgres's shared lock table on a real catalogue.
    const pages = [
      Array.from({ length: 1_000 }, (_, i) => ({ id: i + 1, documentId: `d${i + 1}` })),
      Array.from({ length: 200 }, (_, i) => ({ id: 1_001 + i, documentId: `d${1_001 + i}` })),
    ];
    let call = 0;
    const query = vi.fn(() => ({
      findMany: vi.fn(async () => pages[call++] ?? []),
    }));
    const transaction = vi.fn(async (callback) => callback({ trx: {} }));
    const bigStrapi = {
      contentTypes: {
        'api::store.store': { pluginOptions: { i18n: { localized: true } } },
      },
      db: { query, transaction },
    } as any;
    mocks.loadPopulatedEntry.mockImplementation(async (_s, _u, documentId) => ({ documentId }));
    mocks.collectTranslatableLeaves.mockReturnValue([{ path: 'name', kind: 'plain', value: 'x' }]);
    mocks.readState.mockResolvedValue(null);
    mocks.activeJob.mockResolvedValue(null);
    mocks.insertTranslationJobsBulk.mockClear();
    const progress: number[] = [];

    const result = await enqueueTranslationBackfill(bigStrapi, {
      mode: 'all',
      uids: ['api::store.store'],
      locales: ['ar'],
      onProgress: (p) => progress.push(p.enqueued),
    });

    expect(result.enqueued).toBe(1_200);
    expect(transaction).toHaveBeenCalledTimes(3);
    const sizes = mocks.insertTranslationJobsBulk.mock.calls.map((c: any[]) => c[1].length);
    expect(sizes).toEqual([500, 500, 200]);
    expect(Math.max(...progress)).toBe(1_200);
    // Progress is reported after each page, so the first page's total is seen
    // before the second page is scanned.
    expect(progress).toContain(1_000);
  });
});
