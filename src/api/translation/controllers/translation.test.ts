import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  localizedApiUids: vi.fn(() => ['api::coupon.coupon']),
  currentBackfillRun: vi.fn(async () => null),
  startTranslationBackfill: vi.fn(async () => ({
    started: true,
    run: { id: 'run-1', status: 'running' },
  })),
  enabledContentLocales: vi.fn(async () => [{ code: 'ar' }]),
  translationRuntimeActive: vi.fn(async () => true),
  enqueueStandaloneTranslationJob: vi.fn(),
  getTranslationStatus: vi.fn(),
  entryTranslationStatus: vi.fn(),
}));

vi.mock('../../../translation/backfill', () => ({
  localizedApiUids: mocks.localizedApiUids,
}));
vi.mock('../../../translation/backfill-run', () => ({
  currentBackfillRun: mocks.currentBackfillRun,
  startTranslationBackfill: mocks.startTranslationBackfill,
}));
vi.mock('../../../translation/locales/registry', () => ({
  enabledContentLocales: mocks.enabledContentLocales,
}));
vi.mock('../../../translation/outbox/runtime', () => ({
  enqueueStandaloneTranslationJob: mocks.enqueueStandaloneTranslationJob,
  getTranslationStatus: mocks.getTranslationStatus,
  translationRuntimeActive: mocks.translationRuntimeActive,
}));
vi.mock('../../../translation/status', () => ({
  entryTranslationStatus: mocks.entryTranslationStatus,
}));

import translationController from './translation';

function context(body: unknown) {
  return {
    request: { body },
    set: vi.fn(),
    status: 0,
    body: null as unknown,
  };
}

describe('translation backfill controller validation', () => {
  const controller = translationController({ strapi: {} as any });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { uids: 'api::coupon.coupon' },
    { locales: 'ar' },
    { mode: 'everything' },
    { dryRun: 'yes' },
    { unexpected: true },
  ])('rejects malformed input instead of silently selecting nothing: %j', async (body) => {
    const ctx = context(body);
    await controller.backfill(ctx);
    expect(ctx.status).toBe(400);
    expect(mocks.startTranslationBackfill).not.toHaveBeenCalled();
  });

  it('rejects typoed UIDs and disabled locales', async () => {
    const typo = context({ uids: ['api::cupon.coupon'] });
    await controller.backfill(typo);
    expect(typo.status).toBe(400);
    expect(typo.body).toEqual({
      error: 'Unknown localized content type: api::cupon.coupon',
    });

    const locale = context({ locales: ['fr'] });
    await controller.backfill(locale);
    expect(locale.status).toBe(400);
    expect(locale.body).toEqual({ error: 'Target locale "fr" is not enabled.' });
    expect(mocks.startTranslationBackfill).not.toHaveBeenCalled();
  });

  it('deduplicates valid filters and starts a durable repair run', async () => {
    const ctx = context({
      mode: 'repair',
      uids: ['api::coupon.coupon', 'api::coupon.coupon'],
      locales: ['ar', 'ar'],
      dryRun: false,
    });
    await controller.backfill(ctx);

    expect(ctx.status).toBe(202);
    expect(mocks.startTranslationBackfill).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        mode: 'repair',
        uids: ['api::coupon.coupon'],
        locales: ['ar'],
      }),
    );
  });
});
