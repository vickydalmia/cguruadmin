import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  translationRuntimeActive: vi.fn(async () => true),
  enqueueStandaloneTranslationJob: vi.fn(async () => undefined),
  enabledContentLocaleCodesSync: vi.fn((): readonly string[] => ['ar', 'hi']),
}));

vi.mock('../outbox/runtime', () => ({
  translationRuntimeActive: mocks.translationRuntimeActive,
  enqueueStandaloneTranslationJob: mocks.enqueueStandaloneTranslationJob,
}));
vi.mock('../locales/registry', () => ({
  enabledContentLocaleCodesSync: mocks.enabledContentLocaleCodesSync,
}));

import { enqueueUiDictionaryJobs } from './enqueue';

const strapi = {} as any;

describe('enqueueUiDictionaryJobs', () => {
  it('is inert while the translation runtime is not active', async () => {
    mocks.translationRuntimeActive.mockResolvedValueOnce(false);
    await expect(enqueueUiDictionaryJobs(strapi, { reason: 'catalogue sync' })).resolves.toEqual({
      enqueued: [],
    });
    expect(mocks.enqueueStandaloneTranslationJob).not.toHaveBeenCalled();
  });

  it('enqueues one synthetic dictionary job per enabled locale', async () => {
    await expect(enqueueUiDictionaryJobs(strapi, { reason: 'catalogue sync' })).resolves.toEqual({
      enqueued: ['ar', 'hi'],
    });
    expect(mocks.enqueueStandaloneTranslationJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueStandaloneTranslationJob).toHaveBeenNthCalledWith(1, strapi, {
      uid: 'ui-dictionary',
      documentId: 'catalogue',
      targetLocale: 'ar',
      kind: 'translate',
      force: false,
      reason: 'catalogue sync',
    });
  });

  it('restricts to requested enabled locales and propagates force', async () => {
    await expect(
      enqueueUiDictionaryJobs(strapi, { locales: ['hi', 'zz', 'hi'], force: true, reason: 're-translate' }),
    ).resolves.toEqual({ enqueued: ['hi'] });
    expect(mocks.enqueueStandaloneTranslationJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueStandaloneTranslationJob).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({ targetLocale: 'hi', force: true, reason: 're-translate' }),
    );
  });
});
