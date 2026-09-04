import { describe, expect, it, vi } from 'vitest';
import type { TranslationConfig } from '../config';
import { TranslationError } from '../errors';
import type { TranslationOutboxConfig } from './config';
import type { TranslationJob } from './store';

const mocks = vi.hoisted(() => {
  const store = {
    claim: vi.fn(async (): Promise<unknown> => null),
    refreshLease: vi.fn(async () => true),
    markDelivered: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    markBlocked: vi.fn(async () => true),
    enqueueBlockedDependents: vi.fn(async () => 0),
    scheduleRetry: vi.fn(async () => ({
      owned: true,
      superseded: false,
      attemptCount: 1,
      delayMs: 30_000,
    })),
    providerAttemptHooks: vi.fn(() => ({})),
    previousJob: vi.fn(),
    readState: vi.fn(),
    upsertState: vi.fn(async () => undefined),
    deleteState: vi.fn(async () => undefined),
  };
  return {
    store,
    processUiDictionaryJob: vi.fn(),
    enabledContentLocales: vi.fn(async () => [{ code: 'ar', name: 'Arabic' }]),
    logTranslation: vi.fn(),
    loadPopulatedEntry: vi.fn(),
    inspectLocaleVersion: vi.fn(),
    writeLocaleVersion: vi.fn(),
    deleteLocaleVersion: vi.fn(),
    collectTranslatableLeaves: vi.fn(),
    resolveRelationDependencies: vi.fn(async () => ({
      existence: { present: new Set() },
      missing: [],
      required: [],
      optional: [],
    })),
    sourceContentHash: vi.fn(() => 'hash-1'),
    translationPromptFingerprint: vi.fn(() => 'prompt-1'),
    translateEntryLeaves: vi.fn(),
  };
});

vi.mock('../ui-dictionary/translate-dictionary', () => ({
  processUiDictionaryJob: mocks.processUiDictionaryJob,
}));
vi.mock('../locales/registry', () => ({ enabledContentLocales: mocks.enabledContentLocales }));
vi.mock('./log', () => ({ logTranslation: mocks.logTranslation }));
vi.mock('../writer', () => ({
  TranslationDependencyBlockedError: class TranslationDependencyBlockedError extends Error {
    dependencies: unknown[] = [];
  },
  loadPopulatedEntry: mocks.loadPopulatedEntry,
  inspectLocaleVersion: mocks.inspectLocaleVersion,
  writeLocaleVersion: mocks.writeLocaleVersion,
  deleteLocaleVersion: mocks.deleteLocaleVersion,
}));
vi.mock('../field-map', () => ({
  collectTranslatableLeaves: mocks.collectTranslatableLeaves,
  resolveRelationDependencies: mocks.resolveRelationDependencies,
}));
vi.mock('../source-hash', () => ({ sourceContentHash: mocks.sourceContentHash }));
vi.mock('../prompts', () => ({
  translationPromptFingerprint: mocks.translationPromptFingerprint,
}));
vi.mock('../translate-entry', () => ({
  translateEntryLeaves: mocks.translateEntryLeaves,
}));
vi.mock('./store', () => ({
  TranslationOutboxStore: class {
    constructor() {
      return mocks.store;
    }
  },
}));

import {
  TranslationDispatcher,
  isPermanentTranslationWriteError,
  shouldRetryTranslationFailure,
} from './dispatcher';

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
  enabled: true,
  pollMs: 60_000,
  batchSize: 1,
  leaseMs: 60_000,
  maxBackoffMs: 60_000,
  retentionDays: 7,
  alertAfterAttempts: 5,
  backlogAlertMs: 60_000,
  qualityRetryMax: 1,
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
  lastError: null,
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

  it('does not repeat an unchanged terminal dictionary failure every night', async () => {
    const nightlyJob = { ...JOB, reason: 'nightly consistency' };
    mocks.store.claim.mockResolvedValueOnce(nightlyJob);
    mocks.store.previousJob.mockResolvedValueOnce({
      status: 'failed',
      createdAt: new Date('2026-09-03T04:00:00Z'),
    });
    mocks.processUiDictionaryJob.mockClear();
    const { dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.processUiDictionaryJob).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).toHaveBeenCalledWith(nightlyJob);
    expect(mocks.logTranslation).toHaveBeenCalledWith(
      expect.anything(),
      'info',
      'translation.job_delivered',
      expect.objectContaining({
        skipped: true,
        reason: expect.stringContaining('unchanged terminal failure'),
      }),
    );
  });
});

describe('translation locale-write retry policy', () => {
  it('allows one durable quality retry, then stops buying identical attempts', () => {
    const failure = new TranslationError('TRANSLATION_QUALITY_GATE_FAILED');
    expect(shouldRetryTranslationFailure(failure, 0, 1)).toBe(true);
    expect(shouldRetryTranslationFailure(failure, 1, 1)).toBe(false);
    expect(
      shouldRetryTranslationFailure(
        new TranslationError('TRANSLATION_TIMED_OUT'),
        20,
        1,
      ),
    ).toBe(true);
  });

  it('terminalizes legacy over-limit quality jobs without another provider call', async () => {
    const legacyJob = {
      ...JOB,
      attemptCount: 9,
      lastError:
        'TRANSLATION_QUALITY_GATE_FAILED: writer output failed validation',
    };
    mocks.store.claim.mockResolvedValueOnce(legacyJob);
    mocks.processUiDictionaryJob.mockClear();
    mocks.store.markFailed.mockClear();
    const { dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.processUiDictionaryJob).not.toHaveBeenCalled();
    expect(mocks.store.markFailed).toHaveBeenCalledWith(
      legacyJob,
      expect.stringContaining('quality retry limit reached after 9 retries'),
    );
  });

  it('stops on validation and PostgreSQL integrity failures', () => {
    expect(
      isPermanentTranslationWriteError({
        name: 'ValidationError',
        message: 'name cannot produce a stable route',
      }),
    ).toBe(true);
    expect(
      isPermanentTranslationWriteError({
        message: 'insert failed',
        cause: { code: '23505', constraint: 'stores_document_id_uq' },
      }),
    ).toBe(true);
  });

  it('keeps transient connection failures retryable', () => {
    expect(
      isPermanentTranslationWriteError({
        code: 'ECONNRESET',
        message: 'connection reset by peer',
      }),
    ).toBe(false);
  });
});

describe('TranslationDispatcher — hash-current content', () => {
  const contentJob: TranslationJob = {
    ...JOB,
    eventKey: 'api::store.store:store-1:ar',
    uid: 'api::store.store',
    documentId: 'store-1',
    reason: 'backfill',
  };
  const source = { documentId: 'store-1', name: 'Store' };

  it('blocks on required locale relations before making a provider call', async () => {
    mocks.store.claim.mockResolvedValueOnce(contentJob);
    mocks.loadPopulatedEntry.mockResolvedValueOnce(source);
    mocks.collectTranslatableLeaves.mockReturnValueOnce([
      { path: 'name', kind: 'plain', value: 'Store' },
    ]);
    mocks.store.readState.mockResolvedValueOnce(null);
    mocks.resolveRelationDependencies.mockResolvedValueOnce({
      existence: { present: new Set() },
      missing: [],
      required: [
        {
          path: 'stores',
          targetUid: 'api::store.store',
          documentId: 'store-2',
          required: true,
        },
      ],
      optional: [],
    });
    mocks.translateEntryLeaves.mockClear();
    mocks.writeLocaleVersion.mockClear();
    mocks.store.markBlocked.mockClear();

    await expect(dispatcher().dispatchOne()).resolves.toBe(true);

    expect(mocks.translateEntryLeaves).not.toHaveBeenCalled();
    expect(mocks.writeLocaleVersion).not.toHaveBeenCalled();
    expect(mocks.store.markBlocked).toHaveBeenCalledWith(
      contentJob,
      [expect.objectContaining({ documentId: 'store-2' })],
      expect.stringContaining('required relation'),
    );
  });

  it('keeps paid memory when a required relation disappears during translation', async () => {
    const leaves = [{ path: 'name', kind: 'plain' as const, value: 'Store' }];
    const dependency = {
      path: 'stores',
      targetUid: 'api::store.store',
      documentId: 'store-2',
      required: true,
    };
    mocks.store.claim.mockResolvedValueOnce(contentJob);
    mocks.loadPopulatedEntry
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source);
    mocks.collectTranslatableLeaves.mockReturnValue(leaves);
    mocks.store.readState.mockResolvedValueOnce(null);
    mocks.resolveRelationDependencies
      .mockResolvedValueOnce({
        existence: { present: new Set() },
        missing: [],
        required: [],
        optional: [],
      })
      .mockResolvedValueOnce({
        existence: { present: new Set() },
        missing: [dependency],
        required: [dependency],
        optional: [],
      });
    mocks.translateEntryLeaves.mockResolvedValueOnce({
      translations: new Map([['name', 'المتجر']]),
      needsReview: false,
      reviewNotes: [],
      inputTokens: 4,
      outputTokens: 2,
      model: 'fake',
    });
    mocks.store.upsertState.mockClear();
    mocks.writeLocaleVersion.mockClear();
    mocks.store.markBlocked.mockClear();

    await expect(dispatcher().dispatchOne()).resolves.toBe(true);

    expect(mocks.store.upsertState).toHaveBeenCalledWith(
      contentJob.uid,
      contentJob.documentId,
      contentJob.targetLocale,
      expect.objectContaining({ translations: { name: 'المتجر' } }),
    );
    expect(mocks.writeLocaleVersion).not.toHaveBeenCalled();
    expect(mocks.store.markBlocked).toHaveBeenCalledWith(
      contentJob,
      [dependency],
      expect.stringContaining('required relation'),
    );
  });

  it('reuses paid translation memory after publication validation fails', async () => {
    const retryJob = { ...contentJob, id: '8', lockToken: 'token-2' };
    const leaves = [{ path: 'name', kind: 'plain' as const, value: 'Store' }];
    mocks.store.claim
      .mockResolvedValueOnce(contentJob)
      .mockResolvedValueOnce(retryJob);
    mocks.loadPopulatedEntry
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source);
    mocks.collectTranslatableLeaves.mockReturnValue(leaves);
    mocks.store.readState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        sourceHash: 'hash-1',
        translations: { name: 'المتجر' },
        needsReview: false,
        reviewNotes: null,
      });
    mocks.translateEntryLeaves.mockResolvedValueOnce({
      translations: new Map([['name', 'المتجر']]),
      needsReview: false,
      reviewNotes: [],
      inputTokens: 4,
      outputTokens: 2,
      model: 'fake',
    });
    mocks.inspectLocaleVersion.mockResolvedValueOnce({
      current: false,
      skippedRelations: [],
    });
    mocks.writeLocaleVersion
      .mockRejectedValueOnce(Object.assign(new Error('meta title too long'), {
        name: 'ValidationError',
      }))
      .mockResolvedValueOnce({
        skippedRelations: [],
        missingDependencies: [],
        created: false,
      });
    mocks.translateEntryLeaves.mockClear();
    mocks.store.upsertState.mockClear();
    const instance = dispatcher();

    await expect(instance.dispatchOne()).resolves.toBe(true);
    await expect(instance.dispatchOne()).resolves.toBe(true);

    expect(mocks.translateEntryLeaves).toHaveBeenCalledTimes(1);
    expect(mocks.store.upsertState.mock.calls[0]?.[3]).toMatchObject({
      sourceHash: 'hash-1',
      translations: { name: 'المتجر' },
    });
    expect(mocks.writeLocaleVersion).toHaveBeenCalledTimes(2);
    mocks.translateEntryLeaves.mockClear();
    mocks.writeLocaleVersion.mockClear();
    mocks.store.upsertState.mockClear();
  });

  it('does not repeat an unchanged terminal content failure every night', async () => {
    const nightlyJob = { ...contentJob, reason: 'nightly consistency' };
    mocks.store.claim.mockResolvedValueOnce(nightlyJob);
    mocks.store.previousJob.mockResolvedValueOnce({
      status: 'failed',
      createdAt: new Date('2026-09-03T04:00:00Z'),
    });
    mocks.loadPopulatedEntry.mockResolvedValueOnce({
      ...source,
      updatedAt: '2026-09-03T03:00:00Z',
    });
    mocks.translateEntryLeaves.mockClear();
    const { dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.collectTranslatableLeaves).not.toHaveBeenCalled();
    expect(mocks.translateEntryLeaves).not.toHaveBeenCalled();
    expect(mocks.writeLocaleVersion).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).toHaveBeenCalledWith(nightlyJob);
  });

  it('retries a nightly terminal failure after the English source changes', async () => {
    const nightlyJob = { ...contentJob, reason: 'nightly consistency' };
    const changedSource = {
      ...source,
      updatedAt: '2026-09-03T05:00:00Z',
    };
    mocks.store.claim.mockResolvedValueOnce(nightlyJob);
    mocks.store.previousJob.mockResolvedValueOnce({
      status: 'failed',
      createdAt: new Date('2026-09-03T04:00:00Z'),
    });
    mocks.loadPopulatedEntry
      .mockResolvedValueOnce(changedSource)
      .mockResolvedValueOnce(changedSource);
    mocks.collectTranslatableLeaves.mockReturnValueOnce([]);
    mocks.store.readState.mockResolvedValueOnce(null);
    mocks.translateEntryLeaves.mockResolvedValueOnce({
      translations: new Map(),
      needsReview: false,
      reviewNotes: [],
      inputTokens: 4,
      outputTokens: 2,
      costUsd: 0.00001,
    });
    mocks.writeLocaleVersion.mockResolvedValueOnce({
      skippedRelations: [],
      missingDependencies: [],
      created: true,
    });
    mocks.translateEntryLeaves.mockClear();
    const { dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.translateEntryLeaves).toHaveBeenCalledTimes(1);
    expect(mocks.writeLocaleVersion).toHaveBeenCalledTimes(1);
  });

  it('delivers without a documents update when the complete locale plan is current', async () => {
    mocks.store.claim.mockResolvedValueOnce(contentJob);
    mocks.store.readState.mockResolvedValueOnce({
      sourceHash: 'hash-1',
      translations: { name: 'المتجر' },
      needsReview: false,
      reviewNotes: null,
    });
    mocks.collectTranslatableLeaves.mockReturnValue([
      { path: 'name', kind: 'plain', value: 'Store' },
    ]);
    mocks.loadPopulatedEntry
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source);
    mocks.inspectLocaleVersion.mockResolvedValueOnce({
      current: true,
      skippedRelations: [],
    });
    const { dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.inspectLocaleVersion).toHaveBeenCalledTimes(1);
    expect(mocks.writeLocaleVersion).not.toHaveBeenCalled();
    expect(mocks.translateEntryLeaves).not.toHaveBeenCalled();
    expect(mocks.store.markDelivered).toHaveBeenCalledWith(contentJob);
    expect(mocks.logTranslation).toHaveBeenCalledWith(
      expect.anything(),
      'info',
      'translation.job_delivered',
      expect.objectContaining({
        skipped: true,
        reason: 'locale version already current',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
  });

  it('rebuilds from memory when migrate:fresh removed the target row', async () => {
    mocks.store.claim.mockResolvedValueOnce(contentJob);
    mocks.store.readState.mockResolvedValueOnce({
      sourceHash: 'hash-1',
      translations: { name: 'المتجر' },
      needsReview: false,
      reviewNotes: null,
    });
    mocks.collectTranslatableLeaves.mockReturnValue([
      { path: 'name', kind: 'plain', value: 'Store' },
    ]);
    mocks.loadPopulatedEntry
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source);
    mocks.inspectLocaleVersion.mockResolvedValueOnce({
      current: false,
      skippedRelations: [],
    });
    mocks.writeLocaleVersion.mockResolvedValueOnce({
      skippedRelations: [],
      missingDependencies: [],
      created: true,
    });
    const { dispatchOne } = dispatcher();

    await expect(dispatchOne()).resolves.toBe(true);

    expect(mocks.translateEntryLeaves).not.toHaveBeenCalled();
    expect(mocks.writeLocaleVersion).toHaveBeenCalledTimes(1);
    expect(mocks.store.upsertState).toHaveBeenCalledTimes(1);
  });
});
