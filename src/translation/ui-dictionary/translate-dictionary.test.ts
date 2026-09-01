import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationConfig } from '../config';
import { TranslationError } from '../errors';
import { resolveContentLocale, type ContentLocale } from '../locales/resolve';
import type { TranslationJob } from '../outbox/store';
import { resetPromptCacheForTest } from '../prompts';
import { resetTranslationSlotsForTest } from '../provider';
import { UI_DICTIONARY_GROUP_SIZE } from './constants';
import { selectPendingLeaves } from './entries';
import type { CatalogueRow, TranslationRow, UiDictionaryPendingLeaf } from './types';

const mocks = vi.hoisted(() => ({
  requestUiDictionarySweep: vi.fn(async () => ({ skipped: false, id: '1', eventKey: 'k' })),
}));
vi.mock('./isr', () => ({ requestUiDictionarySweep: mocks.requestUiDictionarySweep }));
vi.mock('./store', () => ({
  UiDictionaryStore: class {
    constructor() {
      throw new Error('the production dictionary store must not be built in unit tests');
    }
  },
}));

import { processUiDictionaryJob, uiDictionaryBrief } from './translate-dictionary';

const CONFIG: TranslationConfig = {
  provider: 'openai-compatible',
  apiKey: 'k',
  baseUrl: 'https://api.example/v1',
  model: 'test-model',
  reasoningEffort: 'none',
  concurrency: 2,
  timeoutMs: 5_000,
  maxAttempts: 1,
  maxOutputTokens: 1_000,
  chunkChars: 10_000,
  dailyBudgetUsd: 0,
  inputCostPerMTok: 1,
  outputCostPerMTok: 2,
};

const LOCALE = resolveContentLocale('ar', {
  countryCode: 'AE',
  countryName: 'United Arab Emirates',
}) as ContentLocale;

// Real prompt files are read from the repo root.
const strapi = { dirs: { app: { root: process.cwd() } } } as any;

const JOB: TranslationJob = {
  id: '7',
  eventKey: 'ui-dictionary:catalogue:ar',
  uid: 'ui-dictionary',
  documentId: 'catalogue',
  targetLocale: 'ar',
  kind: 'translate',
  force: false,
  attemptCount: 0,
  lockToken: 'token',
  reason: 'test',
};

const outboxStore = { providerAttemptHooks: vi.fn(() => undefined) } as any;

const leaf = (
  key: string,
  text: string,
  extra: Partial<UiDictionaryPendingLeaf> = {},
): UiDictionaryPendingLeaf => ({
  key,
  text,
  sourceHash: `h-${key}`,
  maxLength: null,
  description: null,
  note: null,
  ...extra,
});

/** The English JSON the writer/editor received in one user message. */
function sourceJson(user: string): Record<string, string> {
  const marker = '## English source JSON\n';
  const start = user.indexOf(marker) + marker.length;
  const end = user.indexOf('\n}', start) + 2;
  return JSON.parse(user.slice(start, end));
}

const arabicFor = (source: string) =>
  ['نص', ...(source.match(/\{[a-zA-Z_][\w.-]*\}/gu) ?? [])].join(' ');

/** Echo provider: translates every key it is asked for unless `failWhen` says otherwise. */
function fakeProvider(failWhen?: (keys: string[]) => Error | undefined) {
  const complete = vi.fn(async ({ user }: { user: string }) => {
    const source = sourceJson(user);
    const error = failWhen?.(Object.keys(source));
    if (error) throw error;
    const out = Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, arabicFor(value)]),
    );
    return { text: JSON.stringify(out), inputTokens: 10, outputTokens: 5, model: 'm' };
  });
  return { name: 'fake', complete };
}

function dictionaryStub(pending: UiDictionaryPendingLeaf[]) {
  return {
    pendingLeaves: vi.fn(async () => pending),
    writeAiTranslations: vi.fn(
      async (_locale: string, rows: readonly { key: string }[]) => ({
        written: rows.length,
        staleDropped: [] as string[],
        guarded: 0,
      }),
    ),
  };
}

const sentKeys = (provider: ReturnType<typeof fakeProvider>) =>
  new Set(provider.complete.mock.calls.flatMap(([req]) => Object.keys(sourceJson(req.user))));

function run(
  dictionary: ReturnType<typeof dictionaryStub>,
  provider: ReturnType<typeof fakeProvider>,
  job: TranslationJob = JOB,
) {
  return processUiDictionaryJob({
    strapi,
    provider,
    config: CONFIG,
    store: outboxStore,
    job,
    locale: LOCALE,
    assertLease: async () => {},
    dictionary,
  });
}

/** GROUP_SIZE + 1 leaves, handed over unsorted: `z.last` alone in group two. */
function twoGroups(): UiDictionaryPendingLeaf[] {
  const first = Array.from({ length: UI_DICTIONARY_GROUP_SIZE }, (_, index) =>
    leaf(`a.k${String(index).padStart(2, '0')}`, `Label ${index}`.replace(/\d+/u, 'x')),
  );
  return [leaf('z.last', 'Show more offers'), ...first.reverse()];
}

beforeEach(() => {
  resetPromptCacheForTest();
  resetTranslationSlotsForTest();
});

describe('processUiDictionaryJob', () => {
  it('skips without a provider call when nothing is pending', async () => {
    const provider = fakeProvider();
    const dictionary = dictionaryStub([]);
    await expect(run(dictionary, provider)).resolves.toEqual({
      outcome: { state: 'skipped', reason: 'dictionary current' },
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    expect(dictionary.pendingLeaves).toHaveBeenCalledWith('ar', false);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(dictionary.writeAiTranslations).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
  });

  it('persists the first group and defers on a retryable failure in the second', async () => {
    const provider = fakeProvider((keys) =>
      keys.includes('z.last')
        ? new TranslationError('TRANSLATION_RATE_LIMITED', { detail: 'slow down' })
        : undefined,
    );
    const dictionary = dictionaryStub(twoGroups());
    const result = await run(dictionary, provider);

    expect(dictionary.writeAiTranslations).toHaveBeenCalledTimes(1);
    const [locale, rows] = dictionary.writeAiTranslations.mock.calls[0];
    expect(locale).toBe('ar');
    expect(rows).toHaveLength(UI_DICTIONARY_GROUP_SIZE);
    expect(rows[0]).toEqual({ key: 'a.k00', text: 'نص', sourceHash: 'h-a.k00' });
    expect(rows.map((row) => row.key)).not.toContain('z.last');

    expect(result.outcome.state).toBe('deferred');
    if (result.outcome.state !== 'deferred') throw new Error('unreachable');
    expect(result.outcome.reason).toContain('1/2 dictionary group(s) failed');
    expect(result.outcome.reason).toContain('z.last');
    expect(result.outcome.reason).toContain('TRANSLATION_RATE_LIMITED');
    expect(result.outcome.delayMs).toBe(0);
    // Writer + editor of group one only; the failed call returned no usage.
    expect(result.usage).toEqual({ tokensIn: 20, tokensOut: 10, costUsd: 0.00004 });
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledWith(strapi);
  });

  it('re-checks the lease after the AI call and never persists once it is lost', async () => {
    const provider = fakeProvider();
    const dictionary = dictionaryStub(twoGroups());
    let checks = 0;
    const assertLease = async () => {
      checks += 1;
      // 1st: before group one's AI call; 2nd: after it, before the write.
      if (checks === 2) throw new TranslationError('TRANSLATION_LEASE_LOST');
    };
    await expect(
      processUiDictionaryJob({
        strapi,
        provider,
        config: CONFIG,
        store: outboxStore,
        job: JOB,
        locale: LOCALE,
        assertLease,
        dictionary,
      }),
    ).rejects.toMatchObject({ code: 'TRANSLATION_LEASE_LOST' });
    expect(provider.complete).toHaveBeenCalled();
    expect(dictionary.writeAiTranslations).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
  });

  it('rethrows a non-retryable error and stops immediately', async () => {
    const provider = fakeProvider(() => new TranslationError('TRANSLATION_REJECTED'));
    const dictionary = dictionaryStub(twoGroups());
    await expect(run(dictionary, provider)).rejects.toMatchObject({
      code: 'TRANSLATION_REJECTED',
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(dictionary.writeAiTranslations).not.toHaveBeenCalled();
    expect(mocks.requestUiDictionarySweep).not.toHaveBeenCalled();
  });

  it('rethrows the budget stop but still sweeps what was already written', async () => {
    const provider = fakeProvider((keys) =>
      keys.includes('z.last') ? new TranslationError('TRANSLATION_BUDGET_EXCEEDED') : undefined,
    );
    const dictionary = dictionaryStub(twoGroups());
    await expect(run(dictionary, provider)).rejects.toMatchObject({
      code: 'TRANSLATION_BUDGET_EXCEEDED',
    });
    expect(dictionary.writeAiTranslations).toHaveBeenCalledTimes(1);
    expect(mocks.requestUiDictionarySweep).toHaveBeenCalledTimes(1);
  });

  it('shows the brief, per-leaf notes and only declared length budgets to the writer', async () => {
    const provider = fakeProvider();
    const dictionary = dictionaryStub([
      leaf('nav.home', 'Home'),
      leaf('offers.count.few', '{count} offers', {
        maxLength: 40,
        note: "plural form 'few' for count like 3",
      }),
    ]);
    const result = await run(dictionary, provider);
    expect(result.outcome).toEqual({ state: 'delivered', notes: '2 key(s), 0 guarded' });

    const writer = provider.complete.mock.calls[0][0].user;
    expect(writer).toContain('* Content type: Storefront UI text');
    expect(writer).toContain('* Target locale: ar');
    expect(writer).toContain(uiDictionaryBrief(LOCALE));
    expect(writer).toContain('coupons and deals website');
    expect(writer).toContain("* offers.count.few: plural form 'few' for count like 3");
    expect(writer).toContain('## Length budgets\n* offers.count.few: maxChars 40');
    expect(writer).not.toContain('nav.home: maxChars');
    expect(writer).not.toContain('nav.home: plural');
    expect(dictionary.writeAiTranslations).toHaveBeenCalledWith('ar', [
      { key: 'nav.home', text: 'نص', sourceHash: 'h-nav.home' },
      { key: 'offers.count.few', text: 'نص {count}', sourceHash: 'h-offers.count.few' },
    ]);
  });

  it('never sends a manual-current key to the provider, force or not', async () => {
    const row = (key: string, text: string): CatalogueRow => ({
      key,
      text,
      description: null,
      maxLength: null,
      pluralOf: null,
      hash: `h-${key}`,
      overrideText: null,
      effectiveHash: `h-${key}`,
      overrideUpdatedBy: null,
      overrideUpdatedAt: null,
      firstSeenAt: null,
      lastSeenAt: null,
      removedAt: null,
    });
    const translation = (key: string, sourceHash: string, origin: 'ai' | 'manual'): TranslationRow => ({
      locale: 'ar',
      key,
      text: 'نص',
      sourceHash,
      origin,
      updatedBy: null,
      updatedAt: null,
    });
    const catalogue = [row('a.manual', 'Copy code'), row('a.missing', 'Go to store'), row('a.stale', 'Verified today'), row('a.aiCurrent', 'Expired')];
    const translations = [
      translation('a.manual', 'h-a.manual', 'manual'),
      translation('a.stale', 'old-hash', 'ai'),
      translation('a.aiCurrent', 'h-a.aiCurrent', 'ai'),
    ];
    const withStoreSemantics = (force: boolean) =>
      dictionaryStub(selectPendingLeaves({ locale: 'ar', catalogue, translations, force }));

    const plain = fakeProvider();
    await run(withStoreSemantics(false), plain);
    expect(sentKeys(plain)).toEqual(new Set(['a.missing', 'a.stale']));

    const forced = fakeProvider();
    await run(withStoreSemantics(true), forced, { ...JOB, force: true });
    expect(sentKeys(forced)).toEqual(new Set(['a.missing', 'a.stale', 'a.aiCurrent']));
  });
});
