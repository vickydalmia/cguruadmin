import { describe, expect, it, vi } from 'vitest';
import type { TranslationConfig } from '../config';
import type { TranslationOutboxConfig } from './config';
import type { TranslationJob } from './store';

const mocks = vi.hoisted(() => {
  const store = {
    claim: vi.fn(async (): Promise<unknown> => null),
    refreshLease: vi.fn(async () => true),
    markDelivered: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => ({
      owned: true,
      superseded: false,
      attemptCount: 1,
      delayMs: 30_000,
    })),
    providerAttemptHooks: vi.fn(() => ({})),
  };
  return {
    store,
    processUiDictionaryJob: vi.fn(),
    enabledContentLocales: vi.fn(async () => [{ code: 'ar', name: 'Arabic' }]),
    logTranslation: vi.fn(),
  };
});

vi.mock('../ui-dictionary/translate-dictionary', () => ({
  processUiDictionaryJob: mocks.processUiDictionaryJob,
}));
vi.mock('../locales/registry', () => ({ enabledContentLocales: mocks.enabledContentLocales }));
vi.mock('./log', () => ({ logTranslation: mocks.logTranslation }));
vi.mock('./store', () => ({
  TranslationOutboxStore: class {
    constructor() {
      return mocks.store;
    }
  },
}));

import { TranslationDispatcher } from './dispatcher';

const CONFIG: TranslationConfig = {
  provider: 'openai-compatible',
  apiKey: 'k',
  baseUrl: 'https://api.example/v1',
  model: 'test-model',
  reasoningEffort: 'none',
  concurrency: 1,
  timeoutMs: 1_000,
  maxAttempts: 1,
  maxOutputTokens: 100,
  chunkChars: 1_000,
  dailyBudgetUsd: 0,
  inputCostPerMTok: 1,
  outputCostPerMTok: 2,
};

const OUTBOX: TranslationOutboxConfig = {
  pollMs: 60_000,
  batchSize: 1,
  leaseMs: 60_000,
  maxBackoffMs: 60_000,
  retentionDays: 7,
  alertAfterAttempts: 5,
  backlogAlertMs: 60_000,
  relationRetryMax: 3,
};

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
  reason: 'catalogue sync',
};

const provider = { name: 'fake', complete: vi.fn() };

function dispatcher() {
  const strapi = {
    getModel: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
  const instance = new TranslationDispatcher(strapi, CONFIG, OUTBOX, provider);
  return { strapi, dispatchOne: () => (instance as any).dispatchOne() as Promise<boolean> };
}

describe('TranslationDispatcher — ui-dictionary hand-off', () => {
  it('routes the synthetic uid to processUiDictionaryJob without touching the content model', async () => {
    mocks.store.claim.mockResolvedValueOnce(JOB);
    mocks.processUiDictionaryJob.mockResolvedValueOnce({
      outcome: { state: 'delivered', notes: '3 key(s), 0 guarded' },
      usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.00002 },
    });
    const { strapi, dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(strapi.getModel).not.toHaveBeenCalled();
    expect(mocks.processUiDictionaryJob).toHaveBeenCalledTimes(1);
    expect(mocks.processUiDictionaryJob).toHaveBeenCalledWith({
      strapi,
      provider,
      config: CONFIG,
      store: mocks.store,
      job: JOB,
      locale: expect.objectContaining({ code: 'ar' }),
      assertLease: expect.any(Function),
    });
    // Same bookkeeping as a content job: delivered row + usage in the log line.
    expect(mocks.store.markDelivered).toHaveBeenCalledWith(JOB);
    expect(mocks.logTranslation).toHaveBeenCalledWith(
      strapi,
      'info',
      'translation.job_delivered',
      expect.objectContaining({
        jobId: '7',
        eventKey: JOB.eventKey,
        skipped: false,
        reason: '3 key(s), 0 guarded',
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.00002,
      }),
    );
  });

  it('schedules a retry for a deferred dictionary outcome exactly like a content job', async () => {
    mocks.store.claim.mockResolvedValueOnce(JOB);
    mocks.processUiDictionaryJob.mockResolvedValueOnce({
      outcome: { state: 'deferred', reason: '1/2 dictionary group(s) failed: z.last (x)', delayMs: 0 },
      usage: { tokensIn: 20, tokensOut: 10, costUsd: 0.00004 },
    });
    const { strapi, dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(strapi.getModel).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).not.toHaveBeenCalled();
    expect(mocks.store.scheduleRetry).toHaveBeenCalledWith(
      JOB,
      '1/2 dictionary group(s) failed: z.last (x)',
      undefined,
    );
    expect(mocks.logTranslation).toHaveBeenCalledWith(
      strapi,
      'warn',
      'translation.job_deferred',
      expect.objectContaining({ jobId: '7', retryInMs: 30_000 }),
    );
  });

  it('skips the dictionary job when its locale is no longer enabled', async () => {
    mocks.store.claim.mockResolvedValueOnce({ ...JOB, targetLocale: 'hi' });
    const { strapi, dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.processUiDictionaryJob).not.toHaveBeenCalled();
    expect(strapi.getModel).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).toHaveBeenCalledTimes(1);
  });
});
