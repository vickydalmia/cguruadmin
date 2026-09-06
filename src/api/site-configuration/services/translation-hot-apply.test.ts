import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.mock('./cached-configuration', () => ({
  invalidateCachedSiteConfiguration: vi.fn(() => calls.push('invalidate')),
}));
vi.mock('../../../translation/ensure-locales', () => ({
  ensureContentLocales: vi.fn(async () => {
    calls.push('ensure');
  }),
}));
vi.mock('../../../translation/locales/registry', () => ({
  primeEnabledContentLocales: vi.fn(async () => {
    calls.push('prime');
  }),
  enabledContentLocaleCodesSync: vi.fn(() => ['ar']),
}));
vi.mock('../../../translation/config', () => ({
  translationConfigFromEnv: vi.fn(() => null),
  translationConfigProblem: vi.fn(() => 'TRANSLATION_PROVIDER is not set'),
}));

let running = false;
vi.mock('../../../translation/outbox/runtime', () => ({
  translationOutboxRunning: vi.fn(() => running),
  startTranslationOutbox: vi.fn(async () => {
    calls.push('start');
    running = true;
  }),
  stopTranslationOutbox: vi.fn(async () => {
    calls.push('stop');
    running = false;
  }),
}));

import { ensureContentLocales } from '../../../translation/ensure-locales';
import { translationConfigFromEnv } from '../../../translation/config';
import { enabledContentLocaleCodesSync } from '../../../translation/locales/registry';
import {
  startTranslationOutbox,
  stopTranslationOutbox,
} from '../../../translation/outbox/runtime';
import { applyTranslationSettings } from './translation-hot-apply';

function fakeStrapi() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { strapi: { log } as any, log };
}

function events(fn: ReturnType<typeof vi.fn>): any[] {
  return fn.mock.calls.map(([line]) => JSON.parse(String(line)));
}

beforeEach(() => {
  calls.length = 0;
  running = false;
});

describe('applyTranslationSettings', () => {
  it('invalidates the memo, then ensures and primes the locales in bootstrap order', async () => {
    const { strapi } = fakeStrapi();
    const outcome = await applyTranslationSettings(strapi);
    expect(calls).toEqual(['invalidate', 'ensure', 'prime']);
    expect(outcome).toEqual({ ok: true, outbox: 'env-missing' });
    expect(ensureContentLocales).toHaveBeenCalledWith(strapi);
  });

  it('never starts the outbox when the TRANSLATION_* env does not parse', async () => {
    const { strapi, log } = fakeStrapi();
    await applyTranslationSettings(strapi);
    expect(startTranslationOutbox).not.toHaveBeenCalled();
    expect(events(log.info)).toContainEqual({
      event: 'translation.hot_apply',
      component: 'translation',
      outbox: 'env-missing',
      reason: 'TRANSLATION_PROVIDER is not set',
    });
  });

  it('starts the outbox once when the env parses and nothing is running', async () => {
    vi.mocked(translationConfigFromEnv).mockReturnValue({} as any);
    const { strapi, log } = fakeStrapi();
    const outcome = await applyTranslationSettings(strapi);
    expect(calls).toEqual(['invalidate', 'ensure', 'prime', 'start']);
    expect(outcome).toEqual({ ok: true, outbox: 'started' });
    expect(events(log.info)).toContainEqual(
      expect.objectContaining({ event: 'translation.hot_apply', outbox: 'started' }),
    );
  });

  it('reports not-started when the outbox declined to run (no target language)', async () => {
    vi.mocked(translationConfigFromEnv).mockReturnValue({} as any);
    vi.mocked(startTranslationOutbox).mockImplementationOnce(async () => {
      calls.push('start');
    });
    const { strapi } = fakeStrapi();
    expect(await applyTranslationSettings(strapi)).toEqual({ ok: true, outbox: 'not-started' });
  });

  it('leaves a running dispatcher alone', async () => {
    running = true;
    vi.mocked(translationConfigFromEnv).mockReturnValue({} as any);
    const { strapi } = fakeStrapi();
    const outcome = await applyTranslationSettings(strapi);
    expect(startTranslationOutbox).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true, outbox: 'already-running' });
    // The locale steps still ran: a NEW language needs its i18n row and a
    // fresh sync mirror even though the dispatcher is already up.
    expect(calls).toEqual(['invalidate', 'ensure', 'prime']);
  });

  it('stops a running dispatcher as soon as Country Setup disables translation', async () => {
    running = true;
    vi.mocked(enabledContentLocaleCodesSync).mockReturnValueOnce([]);
    const { strapi, log } = fakeStrapi();

    const outcome = await applyTranslationSettings(strapi);

    expect(stopTranslationOutbox).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['invalidate', 'ensure', 'prime', 'stop']);
    expect(outcome).toEqual({ ok: true, outbox: 'stopped' });
    expect(events(log.info)).toContainEqual(
      expect.objectContaining({ event: 'translation.hot_apply', outbox: 'stopped' }),
    );
  });

  it('swallows a locale bootstrap failure, logs it loudly and skips the outbox', async () => {
    vi.mocked(translationConfigFromEnv).mockReturnValue({} as any);
    vi.mocked(ensureContentLocales).mockRejectedValueOnce(new Error('i18n unavailable'));
    const { strapi, log } = fakeStrapi();
    const outcome = await applyTranslationSettings(strapi);
    expect(outcome).toEqual({ ok: false, error: 'i18n unavailable' });
    expect(calls).toEqual(['invalidate']);
    expect(startTranslationOutbox).not.toHaveBeenCalled();
    expect(events(log.error)).toContainEqual(
      expect.objectContaining({
        event: 'translation.hot_apply_failed',
        step: 'content-locales',
        error: 'i18n unavailable',
      }),
    );
  });

  it('swallows an outbox start failure and logs it', async () => {
    vi.mocked(translationConfigFromEnv).mockReturnValue({} as any);
    vi.mocked(startTranslationOutbox).mockRejectedValueOnce(new Error('boom'));
    const { strapi, log } = fakeStrapi();
    const outcome = await applyTranslationSettings(strapi);
    expect(outcome).toEqual({ ok: false, error: 'boom' });
    expect(events(log.error)).toContainEqual(
      expect.objectContaining({ event: 'translation.hot_apply_failed', step: 'outbox-start' }),
    );
  });
});
